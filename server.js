const express = require('express');
const dotenv = require('dotenv');
const { DateTime, Settings } = require('luxon');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const pLimit = require('p-limit');
const SheetsDB = require('./sheets');
const fetchData = require('./fetchData.cjs');
const data = require('./data.js');
const Fuse = require('fuse.js');

dotenv.config();

Settings.defaultZone = 'Europe/Kyiv';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const bot = new TelegramBot(TELEGRAM_TOKEN);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [new winston.transports.Console()],
});

// Константы
const RATE_LIMIT_MS = 1000;
const PING_TIMEOUT_SEC = 180;
const LIGHTS_CHECK_INTERVAL_MS = 60_000;
const DTEK_CHECK_MINUTES = 15;
const PARALLEL_LIMIT = 20; // Одновременных операций
const TELEGRAM_LIMIT = 25; // Telegram: 30 msg/sec, оставляем запас

const db = new SheetsDB(logger);
const cities = Object.keys(data.streets);
const fuseCities = new Fuse(cities, { threshold: 0.4 });
const userSessions = {};
const userRateLimits = {};

// Кеш для DTEK запросов (5 минут)
const dtekCache = new Map();
const DTEK_CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Кеш пользователей (обновляется каждую минуту)
let usersCache = new Map(); // chatId -> row
let usersCacheTimestamp = 0;
const USERS_CACHE_TTL = 60 * 1000; // 1 минута

// Лимитеры для параллельной обработки
const parallelLimit = pLimit(PARALLEL_LIMIT);
const telegramLimit = pLimit(TELEGRAM_LIMIT);

// Очередь Telegram сообщений с rate limiting
class TelegramQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }
    
    async add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }
    
    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        
        while (this.queue.length > 0) {
            const batch = this.queue.splice(0, TELEGRAM_LIMIT);
            await Promise.all(batch.map(({ fn, resolve, reject }) => 
                fn().then(resolve).catch(reject)
            ));
            if (this.queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        this.processing = false;
    }
}

const telegramQueue = new TelegramQueue();

// Утилиты
const checkRateLimit = (chatId) => {
    const now = Date.now();
    if (userRateLimits[chatId] && (now - userRateLimits[chatId]) < RATE_LIMIT_MS) return false;
    userRateLimits[chatId] = now;
    return true;
};

const parseDateTime = (timeString) => {
    if (!timeString?.trim()) return DateTime.now();
    const clean = timeString.startsWith("'") ? timeString.substring(1) : timeString;
    for (const fmt of ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy H:mm:ss']) {
        const dt = DateTime.fromFormat(clean, fmt);
        if (dt.isValid) return dt;
    }
    const dt = DateTime.fromISO(clean);
    return dt.isValid ? dt : DateTime.now();
};

// Обновление кеша пользователей
const refreshUsersCache = async () => {
    try {
        const rows = await db.getAllLightStates();
        usersCache.clear();
        rows.forEach(row => usersCache.set(row.chat_id, row));
        usersCacheTimestamp = Date.now();
        logger.info(`Кеш пользователей обновлен: ${rows.length} пользователей`);
    } catch (error) {
        logger.error('Ошибка обновления кеша пользователей:', error);
    }
};

// Получение пользователя из кеша (с автообновлением)
const getUserFromCache = async (chatId) => {
    // Если пользователя нет в кеше - загружаем из БД
    if (!usersCache.has(chatId)) {
        logger.info(`Кеш: пользователь ${chatId} не найден, загружаем из БД`);
        const row = await db.getLightState(chatId);
        if (row) {
            usersCache.set(chatId, row);
            return row;
        }
        return null;
    }
    
    // Обновляем весь кеш если устарел
    if (Date.now() - usersCacheTimestamp > USERS_CACHE_TTL) {
        await refreshUsersCache();
    }
    
    return usersCache.get(chatId);
};

// Обновление одного пользователя в кеше
const updateUserInCache = (chatId, row) => {
    usersCache.set(chatId, row);
};

// Инвалидация пользователя в кеше (принудительное обновление при следующем запросе)
const invalidateUserCache = (chatId) => {
    usersCache.delete(chatId);
};

const shouldSkipChat = async (chatId) => {
    const row = await getUserFromCache(chatId);
    return row?.ignored || false;
};

const hasDeviceConnected = (row, { strict = false } = {}) => {
    const hasTimes = row?.last_ping_time?.trim() && row?.light_start_time?.trim();
    return hasTimes && (!strict || row.last_ping_time !== row.light_start_time);
};

const formatMessage = (row, short = false) => {
    const duration = DateTime.now().diff(parseDateTime(row.light_start_time));
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    if (short) return `${icon} Свет ${state}\n⏱${duration.toFormat("d'd' h'ч' m'мин' s'с'")}`;  
    return `${icon} Свет ${state}\n⏱ Текущий статус: ${duration.toFormat('hh:mm:ss')}\n📊 Предыдущий статус: ${row.previous_duration || 'неизвестно'}`;
};

// Унифицированная логика получения и суммирования данных DTEK
async function fetchAndSummarizeDtek(city, street, house_number) {
    try {
        const addressText = house_number ? `${city}, ${street}, ${house_number}` : `${city}, ${street} (вся улица)`;
        const cacheKey = `${city}|${street}|${house_number}`;
        
        // Проверяем кеш
        const cached = dtekCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < DTEK_CACHE_TTL)) {
            logger.info(`DTEK: используем кеш для ${addressText}`);
            return cached.data;
        }
        
        const result = await fetchData(city, street, house_number);
        
        if (!result) {
            return { inferredOff: false, message: `Не удалось получить данные для ${addressText}.` };
        }

        const { data, updateTimestamp, resolvedHomeKey, showCurOutageParam } = result;
        const keyToUse = (resolvedHomeKey && data?.[resolvedHomeKey]) ? resolvedHomeKey : house_number;
        const houseData = data[keyToUse] || {};

        // Если нет прямого отключения по дому и глобальный флаг не активен — отключений нет
        if (!houseData.sub_type && !showCurOutageParam) {
            const resultData = { inferredOff: false, message: `По адресу ${addressText} отключений нет. Обновлено: ${updateTimestamp}`, updateTimestamp };
            dtekCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
            return resultData;
        }

        // Флаг на уровне улицы активен, но по дому данных нет — суммаризируем по активным записям
        if (!houseData.sub_type && showCurOutageParam) {
            const all = Object.values(data || {});
            const isActive = (x) => !!(x && ((x.sub_type && x.sub_type.trim()) || (x.start_date && x.start_date.trim()) || (x.end_date && x.end_date.trim())));
            const activeEntries = all.filter(isActive);
            if (activeEntries.length === 0) {
                const resultData = { inferredOff: false, message: `По адресу ${addressText} отключений нет. Обновлено: ${updateTimestamp}`, updateTimestamp };
                dtekCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
                return resultData;
            }

            const reasons = [...new Set(activeEntries.flatMap(x => Array.isArray(x?.sub_type_reason) ? x.sub_type_reason : []).filter(Boolean))];
            const parseMaybe = (s) => {
                if (!s || !s.trim()) return null;
                const dt = DateTime.fromFormat(s.trim(), 'HH:mm dd.MM.yyyy');
                return dt.isValid ? dt : null;
            };
            const starts = activeEntries.map(x => parseMaybe(x?.start_date)).filter(Boolean);
            const ends = activeEntries.map(x => parseMaybe(x?.end_date)).filter(Boolean);
            const minStart = starts.length ? starts.reduce((a,b) => a < b ? a : b) : null;
            const maxEnd = ends.length ? ends.reduce((a,b) => a > b ? a : b) : null;
            const startText = minStart ? minStart.toFormat('HH:mm dd.MM.yyyy') : 'Не указано';
            const endText = maxEnd ? maxEnd.toFormat('HH:mm dd.MM.yyyy') : 'Не указано';

            logger.info('DTEK: outage indicated by flag, summarizing active street entries', { city, street, house_number, reasons, startText, endText });
            const resultData = {
                inferredOff: true,
                message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${addressText}\nСтатус: Зафиксировано ограничение/отключение по улице\nПричины: ${reasons.length ? reasons.join(', ') : 'Не указано'}\nНачало: ${startText}\nОкончание: ${endText}`,
                updateTimestamp
            };
            dtekCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
            return resultData;
        }

        // Прямое отключение по дому
        logger.info('DTEK: outage detected', { city, street, house_number, sub_type: houseData.sub_type, start_date: houseData.start_date, end_date: houseData.end_date, sub_type_reason: houseData.sub_type_reason });
        const resultData = {
            inferredOff: true,
            message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${addressText}\nТип: ${houseData.sub_type || 'Не указано'}\nНачало: ${houseData.start_date || 'Не указано'}\nОкончание: ${houseData.end_date || 'Не указано'}\nТип причины: ${houseData.sub_type_reason?.join(', ') || 'Не указано'}`,
            updateTimestamp
        };
        dtekCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
        return resultData;
    } catch (error) {
        logger.error('Ошибка получения данных DTEK:', error);
        return { inferredOff: false, message: 'Ошибка при получении данных.' };
    }
}

// Получение информации DTEK
const getDtekInfo = async (chatId, updateState = false) => {
    const row = await getUserFromCache(chatId);
    if (!row?.city || !row?.street) return 'Адрес не настроен. Используйте /address.';
    
    // house_number может быть пустым (вся улица)
    const houseNumber = row.house_number?.trim() || '';
    const summary = await fetchAndSummarizeDtek(row.city, row.street, houseNumber);
    
    // Если устройство не подключено и запрошено обновление состояния
    if (updateState && !hasDeviceConnected(row, { strict: true }) && summary.updateTimestamp) {
        const dtekTime = DateTime.fromFormat(summary.updateTimestamp, 'HH:mm dd.MM.yyyy');
        if (dtekTime.isValid) {
            const newState = !summary.inferredOff; // Нет отключений = свет включен
            
            logger.info(`DTEK: обновляем состояние для ${chatId}, устройство не подключено, новое состояние: ${newState ? 'включен' : 'выключен'}, время: ${dtekTime.toFormat('HH:mm dd.MM.yyyy')}`);
            
            // Всегда обновляем состояние для пользователей без устройства
            await db.saveLightState(chatId, dtekTime, newState, dtekTime, null);
            
            // Инвалидируем кеш
            invalidateUserCache(chatId);
            
            // Создаем или обновляем закрепленное сообщение
            const updatedRow = await getUserFromCache(chatId);
            if (updatedRow) {
                logger.info(`DTEK: вызываем updatePinnedMessage для ${chatId}`);
                await updatePinnedMessage(chatId);
            } else {
                logger.error(`DTEK: не удалось получить обновленную строку для ${chatId}`);
            }
        } else {
            logger.error(`DTEK: неверный формат времени для ${chatId}: ${summary.updateTimestamp}`);
        }
    } else {
        logger.info(`DTEK: пропускаем обновление для ${chatId}, updateState=${updateState}, hasDevice=${hasDeviceConnected(row, { strict: true })}, hasTimestamp=${!!summary.updateTimestamp}`);
    }
    
    return summary.message;
};

// Обновление закрепленного сообщения (с rate limiting)
const updatePinnedMessage = async (chatId, message) => {
    if (await shouldSkipChat(chatId)) return;
    const row = await getUserFromCache(chatId);
    if (!row) return;
    
    return telegramQueue.add(async () => {
        try {
            const msg = message || formatMessage(row, true);
            if (row.pinned_message_id) {
                try {
                    await bot.editMessageText(msg, { chat_id: chatId, message_id: row.pinned_message_id });
                } catch (e) {
                    if (!e.message.includes('message is not modified')) throw e;
                }
            } else {
                const sent = await bot.sendMessage(chatId, msg);
                await bot.pinChatMessage(chatId, sent.message_id);
                await db.savePinnedMessageId(chatId, sent.message_id);
                invalidateUserCache(chatId);
            }
        } catch (error) {
            logger.error(`Ошибка обновления закрепленного сообщения ${chatId}: ${error.message}`);
        }
    });
};


// Уведомления (с rate limiting)
const notifyStatusChange = async (chatId, statusMessage) => {
    if (await shouldSkipChat(chatId)) return;
    updatePinnedMessage(chatId);
    await telegramQueue.add(() => bot.sendMessage(chatId, statusMessage));
};

// Обработка пинга
const updatePingTime = async (chatId) => {
    if (await shouldSkipChat(chatId)) return;
    const now = DateTime.now();
    const row = await getUserFromCache(chatId);
    
    if (!row) {
        await db.saveLightState(chatId, now, true, now, null);
        invalidateUserCache(chatId);
        updatePinnedMessage(chatId);
        return bot.sendMessage(chatId, '💡 Свет ВКЛЮЧЕН');
    }
    
    const lightStartTime = parseDateTime(row.light_start_time);
    if (row.light_state) {
        await db.saveLightState(chatId, now, true, lightStartTime, null);
        // Кеш обновится автоматически при следующем запросе
        updatePinnedMessage(chatId);
    } else {
        const offDuration = now.diff(lightStartTime);
        await db.saveLightState(chatId, now, true, now, null);
        invalidateUserCache(chatId);
        await notifyStatusChange(chatId, `💡 Свет ВКЛЮЧЕН\n⏸ Был выключен: ${offDuration.toFormat('hh:mm:ss')}`);
    }
};

// Единая проверка состояния света (оптимизировано для 1000+ пользователей)
const checkLightsStatus = async () => {
    try {
        const startTime = Date.now();
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        
        logger.info(`Начало проверки для ${rows.length} пользователей`);
        
        // Параллельная обработка с лимитом
        await Promise.all(rows.map(row => parallelLimit(async () => {
            if (row.ignored || !row.city?.trim()) return;
            
            const hasDevice = hasDeviceConnected(row, { strict: true });
            
            // Режим с устройством: проверка таймаута пингов
            if (hasDevice) {
                const secs = now.diff(parseDateTime(row.last_ping_time)).as('seconds');
                
                if (secs > PING_TIMEOUT_SEC && row.light_state) {
                    const onDuration = now.diff(parseDateTime(row.light_start_time));
                    await db.saveLightState(row.chat_id, now, false, now, onDuration);
                    invalidateUserCache(row.chat_id);
                    await notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН\n⏸ Был включен: ${onDuration.toFormat('hh:mm:ss')}`);
                    const dtekMsg = await getDtekInfo(row.chat_id);
                    await telegramQueue.add(() => bot.sendMessage(row.chat_id, dtekMsg));
                } else {
                    await updatePinnedMessage(row.chat_id);
                }
            }
            // Режим только DTEK: проверка каждые 15 минут
            else {
                const lastCheck = row.last_ping_time ? parseDateTime(row.last_ping_time) : now.minus({ minutes: DTEK_CHECK_MINUTES + 1 });
                const mins = now.diff(lastCheck).as('minutes');
                
                if (mins >= DTEK_CHECK_MINUTES) {
                    const houseNumber = row.house_number?.trim() || '';
                    const { inferredOff, message: msg } = await fetchAndSummarizeDtek(row.city, row.street, houseNumber);
                    const startTime = parseDateTime(row.light_start_time);

                    if (inferredOff && row.light_state) {
                        await db.saveLightState(row.chat_id, now, false, now, now.diff(startTime));
                        invalidateUserCache(row.chat_id);
                        await notifyStatusChange(row.chat_id, '🌑 Свет ВЫКЛЮЧЕН');
                    } else if (!inferredOff && !row.light_state) {
                        await db.saveLightState(row.chat_id, now, true, now, null);
                        invalidateUserCache(row.chat_id);
                        await notifyStatusChange(row.chat_id, '💡 Свет ВКЛЮЧЕН');
                    } else {
                        await db.saveLightState(row.chat_id, now, row.light_state, startTime, null);
                    }
                    
                    await updatePinnedMessage(row.chat_id);
                    await telegramQueue.add(() => bot.sendMessage(row.chat_id, `📊 DTEK (авто):\n${msg}`));
                } else {
                    // Просто обновляем таймер в закрепленном сообщении
                    await updatePinnedMessage(row.chat_id);
                }
            }
        })));
        
        const duration = Date.now() - startTime;
        logger.info(`Проверка завершена за ${duration}ms для ${rows.length} пользователей`);
    } catch (error) {
        logger.error(`Ошибка проверки: ${error.message}`);
    }
};

// Маршруты
app.get('/check-lights', async (req, res) => {
    await checkLightsStatus();
    res.json({ status: 'ok', message: 'Проверка выполнена' });
});

const handlePing = async (req, res) => {
    const chatId = req.body?.chat_id || req.query?.c || req.query?.chat_id;
    if (chatId && !(await shouldSkipChat(chatId))) {
        updatePingTime(chatId);
    }
    res.send("OK");
};

app.post('/ping', handlePing);
app.get('/ping', handlePing);
app.get('/p', handlePing);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Команды бота
bot.onText(/\/start(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        await db.setIgnored(chatId, false);
        await db.initializeUser(chatId);
        
        // Сохранить информацию о пользователе
        const user = msg.from;
        await db.saveUserInfo(chatId, {
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username
        });
        
        invalidateUserCache(chatId);
        
        const userName = user.first_name || 'Пользователь';
        bot.sendMessage(chatId, `👋 Привет, ${userName}!\n\n🚀 Бот мониторинга света\n\n📋 Команды:\n/start - Это сообщение\n/stop - Отключить бота\n/status - Статус света\n/address - Настроить адрес\n/dtek - Информация об отключениях\n\n💡 Бот отслеживает свет автоматически`);
    } catch (error) {
        logger.error(`/start ${chatId}: ${error.message}`);
    }
});

bot.onText(/\/stop(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        await db.setIgnored(chatId, true);
        invalidateUserCache(chatId);
        bot.sendMessage(chatId, '🚫 Бот отключен. Для возобновления /start');
    } catch (error) {
        logger.error(`/stop ${chatId}: ${error.message}`);
        bot.sendMessage(chatId, '❌ Ошибка');
    }
});

bot.onText(/\/status(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    const row = await getUserFromCache(chatId);
    if (!row) return bot.sendMessage(chatId, '❌ Ошибка. Попробуйте /start.');
    if (row.ignored) return;
    
    if (!row.city?.trim()) {
        return bot.sendMessage(chatId, '📍 Адрес не настроен\n\n💡 Используйте /address\n🔌 Подключите устройство для пингов');
    }
    
    if (!hasDeviceConnected(row, { strict: true })) {
        const dtekMsg = await getDtekInfo(chatId, true);
        invalidateUserCache(chatId);
        const updated = await getUserFromCache(chatId);
        if (updated) {
            return bot.sendMessage(chatId, `${formatMessage(updated)}\n\n📊 DTEK:\n${dtekMsg}`);
        }
        return bot.sendMessage(chatId, `📊 DTEK:\n${dtekMsg}`);
    }
    
    bot.sendMessage(chatId, formatMessage(row));
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    const row = await getUserFromCache(chatId);
    if (row?.ignored) return;
    
    userSessions[chatId] = { step: 'city' };
    
    // Кнопки с популярными городами из data.js
    const keyboard = {
        inline_keyboard: [
            [{ text: 'м. Одеса', callback_data: 'city_м. Одеса' }],
            [{ text: 'м. Чорноморськ', callback_data: 'city_м. Чорноморськ' }],
            [{ text: 'м. Ізмаїл', callback_data: 'city_м. Ізмаїл' }]
        ]
    };
    
    bot.sendMessage(chatId, '🏙 Выберите или введите город:', { reply_markup: keyboard });
});

bot.onText(/\/dtek(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    const row = await getUserFromCache(chatId);
    if (row?.ignored) return;
    
    bot.sendMessage(chatId, await getDtekInfo(chatId, true));
});

// Обработка сообщений для сессий
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Пропускаем команды
    if (text && /^\/(start|stop|status|address|dtek)(?:@\w+)?/.test(text)) return;
    
    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        
        try {
            switch (session.step) {
                case 'city':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, '❌ Название города не может быть пустым. Попробуйте еще раз:');
                    }
                    
                    // Точное совпадение
                    if (data.streets[text]) {
                        session.city = text;
                        session.step = 'street';
                        return bot.sendMessage(chatId, `✅ Город: ${text}\n\n🏠 Введите название улицы:`);
                    }
                    
                    // Поиск похожих
                    const results = fuseCities.search(text);
                    
                    if (results.length === 0) {
                        return bot.sendMessage(chatId, `❌ Город "${text}" не найден.\n\n💡 Проверьте правильность написания или выберите из списка:\nhttps://www.dtek-oem.com.ua/ua/shutdowns\n\nВведите другой город:`);
                    }
                    
                    // Автовыбор при 1 совпадении
                    if (results.length === 1) {
                        session.city = results[0].item;
                        session.step = 'street';
                        return bot.sendMessage(chatId, `✅ Город: ${results[0].item}\n\n🏠 Введите название улицы:`);
                    }
                    
                    // Несколько вариантов
                    const suggestions = results.slice(0, 5);
                    session.citySuggestions = suggestions;
                    const keyboard = {
                        inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_city_${i}` }])
                    };
                    return bot.sendMessage(chatId, '🔍 Найдено несколько вариантов. Выберите:', { reply_markup: keyboard });
                    
                case 'street':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, '❌ Название улицы не может быть пустым. Попробуйте еще раз:');
                    }
                    
                    const streets = data.streets[session.city];
                    
                    // Точное совпадение
                    if (streets.includes(text)) {
                        session.street = text;
                        session.step = 'houseNumber';
                        const keyboard = {
                            inline_keyboard: [[{ text: '⏭ Пропустить (вся улица)', callback_data: 'skip_house' }]]
                        };
                        return bot.sendMessage(chatId, `✅ Улица: ${text}\n\n🏘 Введите номер дома или пропустите для всей улицы:`, { reply_markup: keyboard });
                    }
                    
                    // Поиск похожих
                    const fuseStreets = new Fuse(streets, { threshold: 0.4 });
                    const streetResults = fuseStreets.search(text);
                    
                    if (streetResults.length === 0) {
                        return bot.sendMessage(chatId, `❌ Улица "${text}" не найдена в городе ${session.city}.\n\n💡 Проверьте правильность написания или выберите из списка:\nhttps://www.dtek-oem.com.ua/ua/shutdowns\n\nВведите другую улицу:`);
                    }
                    
                    // Автовыбор при 1 совпадении
                    if (streetResults.length === 1) {
                        session.street = streetResults[0].item;
                        session.step = 'houseNumber';
                        const keyboard = {
                            inline_keyboard: [[{ text: '⏭ Пропустить (вся улица)', callback_data: 'skip_house' }]]
                        };
                        return bot.sendMessage(chatId, `✅ Улица: ${streetResults[0].item}\n\n🏘 Введите номер дома или пропустите для всей улицы:`, { reply_markup: keyboard });
                    }
                    
                    // Несколько вариантов
                    const streetSuggestions = streetResults.slice(0, 5);
                    session.streetSuggestions = streetSuggestions;
                    const streetKeyboard = {
                        inline_keyboard: streetSuggestions.map((r, i) => [{ text: r.item, callback_data: `select_street_${i}` }])
                    };
                    return bot.sendMessage(chatId, '🔍 Найдено несколько вариантов. Выберите:', { reply_markup: streetKeyboard });
                    
                case 'houseNumber':
                    const houseNumber = text?.trim() || '';
                    session.houseNumber = houseNumber;
                    
                    await db.saveAddress(chatId, session.city, session.street, houseNumber, 'dtek_only');
                    invalidateUserCache(chatId);
                    
                    const addressText = houseNumber 
                        ? `📍 Адрес сохранен:\n${session.city}, ${session.street}, ${houseNumber}`
                        : `📍 Адрес сохранен:\n${session.city}, ${session.street} (вся улица)`;
                    
                    bot.sendMessage(chatId, `${addressText}\n\n⚡ /dtek - информация об отключениях\n🔌 Подключите устройство для автоматического мониторинга`);
                    updatePinnedMessage(chatId);
                    delete userSessions[chatId];
                    break;
            }
        } catch (error) {
            logger.error(`Ошибка в сессии для ${chatId}: ${error.message}`);
            bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
            delete userSessions[chatId];
        }
    }
});

// Callback query обработка
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    try {
        // Выбор города из популярных
        if (data.startsWith('city_')) {
            const city = data.replace('city_', '');
            
            if (cities.includes(city)) {
                userSessions[chatId] = { step: 'street', city: city };
                bot.sendMessage(chatId, `✅ Город: ${city}\n\n🏠 Введите название улицы:`);
            }
        }
        // Выбор города из предложенных
        else if (data.startsWith('select_city_')) {
            const index = parseInt(data.replace('select_city_', ''));
            if (userSessions[chatId]?.citySuggestions?.[index]) {
                const city = userSessions[chatId].citySuggestions[index].item;
                userSessions[chatId] = { step: 'street', city: city };
                bot.sendMessage(chatId, `✅ Город: ${city}\n\n🏠 Введите название улицы:`);
            }
        }
        // Выбор улицы из предложенных
        else if (data.startsWith('select_street_')) {
            const index = parseInt(data.replace('select_street_', ''));
            if (userSessions[chatId]?.streetSuggestions?.[index]) {
                const street = userSessions[chatId].streetSuggestions[index].item;
                userSessions[chatId].street = street;
                userSessions[chatId].step = 'houseNumber';
                const keyboard = {
                    inline_keyboard: [[{ text: '⏭ Пропустить (вся улица)', callback_data: 'skip_house' }]]
                };
                bot.sendMessage(chatId, `✅ Улица: ${street}\n\n🏘 Введите номер дома или пропустите для всей улицы:`, { reply_markup: keyboard });
            }
        }
        // Пропустить номер дома
        else if (data === 'skip_house') {
            if (userSessions[chatId]?.step === 'houseNumber') {
                const session = userSessions[chatId];
                await db.saveAddress(chatId, session.city, session.street, '', 'dtek_only');
                invalidateUserCache(chatId);
                bot.sendMessage(chatId, `📍 Адрес сохранен:\n${session.city}, ${session.street} (вся улица)\n\n⚡ /dtek - информация об отключениях\n🔌 Подключите устройство для автоматического мониторинга`);
                updatePinnedMessage(chatId);
                delete userSessions[chatId];
            }
        }
        
        bot.answerCallbackQuery(query.id);
    } catch (error) {
        logger.error(`Ошибка callback для ${chatId}: ${error.message}`);
        bot.answerCallbackQuery(query.id, { text: 'Ошибка обработки' });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 5002;

(async () => {
    try {
        await db.initialize();
        logger.info('Google Sheets подключен');
        
        // Инициализация кеша пользователей
        await refreshUsersCache();
        logger.info('Кеш пользователей инициализирован');
        
        if (WEBHOOK_URL) {
            await bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
            logger.info(`Webhook установлен: ${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
        }
        
        app.listen(PORT, () => logger.info(`Сервер запущен на порту ${PORT}`));
        
        setInterval(checkLightsStatus, LIGHTS_CHECK_INTERVAL_MS);
        logger.info('Единая проверка состояния запущена (каждые 60 секунд)');
        
        setTimeout(() => {
            logger.info('🔄 Выполняем первоначальную проверку состояния...');
            checkLightsStatus();
        }, 2000);
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();