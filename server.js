const express = require('express');
const dotenv = require('dotenv');
const { DateTime } = require('luxon');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const SheetsDB = require('./sheets');
const fetchData = require('./fetchData.cjs');
const data = require('./data.js');
const Fuse = require('fuse.js');

dotenv.config();

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

const db = new SheetsDB(logger);
const cities = Object.keys(data.streets);
const fuseCities = new Fuse(cities, { threshold: 0.4 });
const userSessions = {};
const userRateLimits = {};
const RATE_LIMIT_MS = 1000;
const PING_TIMEOUT_SEC = 180;
const LIGHTS_CHECK_INTERVAL_MS = 60_000;
const DTEK_CHECK_MINUTES = 15;
const DTEK_CHECK_INTERVAL_MS = DTEK_CHECK_MINUTES * 60 * 1000;

// Утилиты
function checkRateLimit(chatId) {
    const now = Date.now();
    const lastRequest = userRateLimits[chatId];
    if (lastRequest && (now - lastRequest) < RATE_LIMIT_MS) return false;
    userRateLimits[chatId] = now;
    return true;
}

function parseDateTime(timeString) {
    if (!timeString?.trim()) return DateTime.now();
    const cleanString = timeString.startsWith("'") ? timeString.substring(1) : timeString;
    const formats = ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy H:mm:ss'];
    
    for (const fmt of formats) {
        const dt = DateTime.fromFormat(cleanString, fmt);
        if (dt.isValid) return dt;
    }
    
    const dt = DateTime.fromISO(cleanString);
    return dt.isValid ? dt : DateTime.now();
}

async function shouldSkipChat(chatId) {
    const row = await db.getLightState(chatId);
    return row?.ignored || false;
}

function hasDeviceConnected(row, { strict = false } = {}) {
    const hasTimes = row?.last_ping_time?.trim() && row?.light_start_time?.trim();
    if (!hasTimes) return false;
    if (!strict) return true;
    return row.last_ping_time !== row.light_start_time;
}

function formatStatusMessage(row) {
    const lightStartTime = parseDateTime(row.light_start_time);
    const currentDuration = DateTime.now().diff(lightStartTime);
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const prevDuration = row.previous_duration || 'неизвестно';
    return `${icon} Свет ${state}\n⏱ Текущий статус: ${currentDuration.toFormat('hh:mm:ss')}\n📊 Предыдущий статус: ${prevDuration}`;
}

// Унифицированная логика получения и суммирования данных DTEK
async function fetchAndSummarizeDtek(city, street, house_number) {
    try {
        const result = await fetchData(city, street, house_number);
        if (!result) {
            return { inferredOff: false, message: `Не удалось получить данные для ${city}, ${street}, ${house_number}.` };
        }

        const { data, updateTimestamp, resolvedHomeKey, showCurOutageParam } = result;
        const keys = Object.keys(data || {});
        const parseNum = (s) => {
            const m = String(s ?? '').match(/\d+/);
            return m ? parseInt(m[0], 10) : NaN;
        };
        const inputNum = parseNum(house_number);
        let keyToUse = (resolvedHomeKey && data?.[resolvedHomeKey]) ? resolvedHomeKey : (data?.[house_number] ? house_number : null);
        if (!keyToUse && keys.length > 0) {
            let bestKey = keys[0];
            if (!Number.isNaN(inputNum)) {
                let bestDiff = Infinity;
                for (const k of keys) {
                    const kn = parseNum(k);
                    if (Number.isNaN(kn)) continue;
                    const diff = Math.abs(kn - inputNum);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestKey = k;
                    }
                }
            }
            keyToUse = bestKey;
        }
        const houseData = (keyToUse && data[keyToUse]) ? data[keyToUse] : {};

        // Если нет прямого отключения по дому и глобальный флаг не активен — отключений нет
        if (!houseData.sub_type && !showCurOutageParam) {
            return { inferredOff: false, message: `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}` };
        }

        // Флаг на уровне улицы активен, но по дому данных нет — суммаризируем по активным записям
        if (!houseData.sub_type && showCurOutageParam) {
            const all = Object.values(data || {});
            const isActive = (x) => !!(x && ((x.sub_type && x.sub_type.trim()) || (x.start_date && x.start_date.trim()) || (x.end_date && x.end_date.trim())));
            const activeEntries = all.filter(isActive);
            if (activeEntries.length === 0) {
                return { inferredOff: false, message: `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}` };
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
            return {
                inferredOff: true,
                message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nСтатус: Зафиксировано ограничение/отключение по улице\nПричины: ${reasons.length ? reasons.join(', ') : 'Не указано'}\nНачало: ${startText}\nОкончание: ${endText}`,
                updateTimestamp
            };
        }

        // Прямое отключение по дому
        logger.info('DTEK: outage detected', { city, street, house_number, sub_type: houseData.sub_type, start_date: houseData.start_date, end_date: houseData.end_date, sub_type_reason: houseData.sub_type_reason });
        return {
            inferredOff: true,
            message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nТип: ${houseData.sub_type || 'Не указано'}\nНачало: ${houseData.start_date || 'Не указано'}\nОкончание: ${houseData.end_date || 'Не указано'}\nТип причины: ${houseData.sub_type_reason?.join(', ') || 'Не указано'}`,
            updateTimestamp
        };
    } catch (error) {
        logger.error('Ошибка получения данных DTEK:', error);
        return { inferredOff: false, message: 'Ошибка при получении данных.' };
    }
}

// Получение информации DTEK
async function getDtekInfo(chatId) {
    const row = await db.getLightState(chatId);
    if (!row?.city || !row?.street || !row?.house_number) {
        return 'Адрес не настроен. Используйте /address для настройки.';
    }

    const { city, street, house_number } = row;
    const summary = await fetchAndSummarizeDtek(city, street, house_number);
    return summary.message;
}

// Обновление закрепленного сообщения
async function updatePinnedMessage(chatId, message) {
    if (await shouldSkipChat(chatId)) return;
    
    const row = await db.getLightState(chatId);
    const mode = row?.mode;
    
    try {
        if (!row) return;
        
        const messageToSend = message || getCurrentStatusMessage(row);
        const pinnedMessageId = row.pinned_message_id;
        
        if (pinnedMessageId) {
            try {
                await bot.editMessageText(messageToSend, { chat_id: chatId, message_id: pinnedMessageId });
            } catch (error) {
                if (!error.message.includes('message is not modified')) throw error;
            }
        } else {
            const sentMsg = await bot.sendMessage(chatId, messageToSend);
            await bot.pinChatMessage(chatId, sentMsg.message_id);
            await db.savePinnedMessageId(chatId, sentMsg.message_id);
        }
    } catch (error) {
        logger.error(`Ошибка обновления закрепленного сообщения для ${chatId}: ${error.message}`);
    }
}

function formatPinnedMessage(row) {
    const currentDuration = DateTime.now().diff(parseDateTime(row.light_start_time));
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const duration = currentDuration.toFormat('d\'д\' h\'ч\' m\'мин\' s\'с\'');
    return `${icon} Свет ${state}\n⏱${duration}`;
}

function getCurrentStatusMessage(row) {
    return formatPinnedMessage(row);
}

// Уведомления
async function notifyStatusChange(chatId, statusMessage) {
    if (await shouldSkipChat(chatId)) return;
    updatePinnedMessage(chatId);
    await bot.sendMessage(chatId, statusMessage)
        .then(() => logger.info('Сообщение отправлено'))
        .catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
}

// Обработка пинга
async function updatePingTime(chatId) {
    if (await shouldSkipChat(chatId)) return;
    
    const now = DateTime.now();
    logger.info(`Получен пинг от ${chatId}`);
    const row = await db.getLightState(chatId);
    
    if (!row) {
        await db.saveLightState(chatId, now, true, now, null);
        const newRow = await db.getLightState(chatId);
        updatePinnedMessage(chatId, getCurrentStatusMessage(newRow));
        return bot.sendMessage(chatId, '💡 Свет ВКЛЮЧЕН');
    }
    
    const lightStartTime = parseDateTime(row.light_start_time);
    
    if (row.light_state) {
        await db.saveLightState(chatId, now, true, lightStartTime, null);
        const newRow = await db.getLightState(chatId);
        updatePinnedMessage(chatId, getCurrentStatusMessage(newRow));
        logger.info(`Свет включен, обновлен last_ping_time для ${chatId}`);
    } else {
        const offDuration = now.diff(lightStartTime);
        await db.saveLightState(chatId, now, true, now, null);
        await notifyStatusChange(chatId, `💡 Свет ВКЛЮЧЕН\n⏸ Был выключен: ${offDuration.toFormat('hh:mm:ss')}`);
        logger.info(`Свет включен для ${chatId} (был выключен ${offDuration.toFormat('hh:mm:ss')})`);
    }
}

// Периодическая проверка DTEK
async function checkDtekStatus() {
    try {
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        
        for (const row of rows) {
            if (row.ignored || !row.city?.trim()) continue;
            
            const lastDtekCheck = row.last_ping_time ? parseDateTime(row.last_ping_time) : DateTime.now().minus({ minutes: DTEK_CHECK_MINUTES + 1 });
            const minutesSinceLastCheck = now.diff(lastDtekCheck).as('minutes');
            
            if (minutesSinceLastCheck >= DTEK_CHECK_MINUTES) {
                // Получаем данные DTEK единой функцией и выводим состояние для адреса
                const { inferredOff, message: messageFromDtek } = await fetchAndSummarizeDtek(row.city, row.street, row.house_number);

                // Обновляем таблицу, если состояние изменилось, и мастер-сообщение
                if (inferredOff && row.light_state) {
                    const onDuration = now.diff(parseDateTime(row.light_start_time));
                    await db.saveLightState(row.chat_id, now, false, now, onDuration);
                    await notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН`);
                } else if (!inferredOff && !row.light_state) {
                    await db.saveLightState(row.chat_id, now, true, now, null);
                    await notifyStatusChange(row.chat_id, `💡 Свет ВКЛЮЧЕН`);
                } else {
                    await db.saveLightState(row.chat_id, now, row.light_state, parseDateTime(row.light_start_time), row.previous_duration);
                    await updatePinnedMessage(row.chat_id);
                }

                const dtekMessage = messageFromDtek || await getDtekInfo(row.chat_id);
                await bot.sendMessage(row.chat_id, `📊 DTEK информация (автоматическая проверка):\n${dtekMessage}`)
                    .catch((error) => logger.error(`Ошибка отправки DTEK: ${error}`));
                logger.info(`DTEK проверка выполнена для ${row.chat_id} (прошло ${Math.round(minutesSinceLastCheck)} минут)`);
            }
        }
    } catch (error) {
        logger.error(`Ошибка DTEK проверки: ${error.message}`);
    }
}

// Проверка состояния света
async function checkLightsStatus() {
    try {
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        
        for (const row of rows) {
            if (row.ignored) continue;
            
            const deviceConnected = hasDeviceConnected(row);
            if (!deviceConnected) continue;
            
            const lastPingTime = parseDateTime(row.last_ping_time);
            const timeSinceLastPing = now.diff(lastPingTime).as('seconds');
            
            if (timeSinceLastPing > PING_TIMEOUT_SEC && row.light_state) {
                const lightStartTime = parseDateTime(row.light_start_time);
                const onDuration = now.diff(lightStartTime);
                await db.saveLightState(row.chat_id, now, false, now, onDuration);
                await notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН\n⏸ Был включен: ${onDuration.toFormat('hh:mm:ss')}`);
                logger.info(`Свет выключен для ${row.chat_id} (нет пинга ${Math.round(timeSinceLastPing)}s)`);
                
                const dtekMessage = await getDtekInfo(row.chat_id);
                await bot.sendMessage(row.chat_id, dtekMessage)
                    .catch((error) => logger.error(`Ошибка отправки DTEK: ${error}`));
            } else {
                await updatePinnedMessage(row.chat_id);
                logger.info(`Мастер-сообщение обновлено для ${row.chat_id} (${row.light_state ? 'включен' : 'выключен'})`);
            }
        }
    } catch (error) {
        logger.error(`Ошибка проверки: ${error.message}`);
    }
}

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
    const startTime = Date.now();
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        await db.setIgnored(chatId, false);
        await db.initializeUser(chatId);
        
        const welcomeMessage = `🚀 Добро пожаловать в бот мониторинга света!

📋 Доступные команды:
/start - Показать это сообщение
/stop - Отключить бота для этого чата
/status - Показать статус света
/address - Настроить адрес для мониторинга отключений
/dtek - Проверить информацию об отключениях по вашему адресу

💡 Бот автоматически отслеживает состояние света и уведомляет об изменениях.
⚡ Для получения информации об отключениях используйте /dtek после настройки адреса.`;

        bot.sendMessage(chatId, welcomeMessage);
        logger.info(`Приветственное сообщение отправлено для ${chatId} (время: ${Date.now() - startTime} ms)`);
    } catch (error) {
        logger.error(`Ошибка в /start для ${chatId}: ${error.message}`);
    }
});

bot.onText(/\/stop(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        await db.setIgnored(chatId, true);
        bot.sendMessage(chatId, '🚫 Бот отключен для этого чата. Все уведомления и команды будут игнорироваться.\n\nДля возобновления работы используйте /start');
        logger.info(`Статус ignored для ${chatId} установлен`);
    } catch (error) {
        logger.error(`Ошибка в /stop для ${chatId}: ${error.message}`);
        bot.sendMessage(chatId, '❌ Произошла ошибка при отключении бота.');
    }
});

bot.onText(/\/status(?:@\w+)?/, async (msg) => {
    const startTime = Date.now();
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId) || await shouldSkipChat(chatId)) return;
    
    const row = await db.getLightState(chatId);
    if (!row) {
        return bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте /start для переинициализации.');
    }
    
    const hasAddress = row.city?.trim();
    
    // Адрес не настроен
    if (!hasAddress) {
        return bot.sendMessage(chatId, '📍 Адрес не настроен\n\n💡 Для получения информации об отключениях используйте /address для настройки адреса\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов');
    }
    
    // Полноценный режим без подключенного устройства
    const deviceConnectedStrict = hasDeviceConnected(row, { strict: true });
    if (!deviceConnectedStrict) {
        return bot.sendMessage(chatId, `📍 Адрес настроен для мониторинга\n🏠 ${row.city}, ${row.street}, ${row.house_number}\n\n💡 Можете использовать /dtek для получения информации об отключениях\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов`);
    }
    
    // Полноценный режим с подключенным устройством
    bot.sendMessage(chatId, formatStatusMessage(row));
    logger.info(`Статус отправлен для ${chatId} (время: ${Date.now() - startTime} ms)`);
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId) || await shouldSkipChat(chatId)) return;
    
    userSessions[chatId] = { step: 'city' };
    const defaultCandidates = ['Одеса', 'Черноморськ', 'Ізмаїл', 'Одесса', 'Черноморск', 'Измаил'];
    let suggestions = defaultCandidates.filter(name => cities.includes(name));
    if (suggestions.length < 3) {
        for (const c of cities) {
            if (!suggestions.includes(c)) suggestions.push(c);
            if (suggestions.length >= 3) break;
        }
    }
    suggestions = suggestions.slice(0, 3);
    userSessions[chatId].citySuggestions = suggestions.map(item => ({ item }));
    const keyboard = {
        inline_keyboard: suggestions.map((name, i) => [{ text: name, callback_data: `select_city_${i}` }])
    };
    bot.sendMessage(chatId, 'Пожалуйста, введите название города или выберите из списка.', { reply_markup: keyboard });
});

bot.onText(/\/dtek(?:@\w+)?/, async (msg) => {
    const startTime = Date.now();
    const chatId = msg.chat.id;
    if (await shouldSkipChat(chatId) || !checkRateLimit(chatId)) return;
    
    const message = await getDtekInfo(chatId);
    bot.sendMessage(chatId, message);
    logger.info(`DTEK информация отправлена для ${chatId} (время: ${Date.now() - startTime} ms)`);
});

// Обработка сообщений для сессий
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (await shouldSkipChat(chatId)) return;
    if (text && /^\/(start|stop|status|address|dtek)(?:@\w+)?/.test(text)) return;
    
    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        
        try {
            switch (session.step) {
                case 'city':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, 'Ошибка: название города не может быть пустым.');
                    }
                    
                    if (!data.streets[text]) {
                        const results = fuseCities.search(text);
                        if (results.length === 1) {
                            session.city = results[0].item;
                            session.step = 'street';
                            bot.sendMessage(chatId, `Город выбран: ${session.city}\nВведите название улицы.`);
                            break;
                        }
                        if (results.length > 0) {
                            const suggestions = results.slice(0, 5);
                            session.citySuggestions = suggestions;
                            const keyboard = {
                                inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_city_${i}` }])
                            };
                            return bot.sendMessage(chatId, 'Город не найден. Выберите вариант:', { reply_markup: keyboard });
                        } else {
                            return bot.sendMessage(chatId, 'Город не найден. Введите точное название города из списка DTEK.');
                        }
                    }
                    
                    session.city = text;
                    session.step = 'street';
                    bot.sendMessage(chatId, 'Введите название улицы.');
                    break;
                    
                case 'street':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, 'Ошибка: название улицы не может быть пустым.');
                    }
                    
                    if (!data.streets[session.city].includes(text)) {
                        const fuseStreets = new Fuse(data.streets[session.city], { threshold: 0.4 });
                        const results = fuseStreets.search(text);
                        if (results.length === 1) {
                            session.street = results[0].item;
                            session.step = 'houseNumber';
                            bot.sendMessage(chatId, `Улица выбрана: ${session.street}\nВведите номер дома.`);
                            break;
                        }
                        if (results.length > 0) {
                            const suggestions = results.slice(0, 5);
                            session.streetSuggestions = suggestions;
                            const keyboard = {
                                inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_street_${i}` }])
                            };
                            return bot.sendMessage(chatId, 'Улица не найдена. Выберите вариант:', { reply_markup: keyboard });
                        } else {
                            return bot.sendMessage(chatId, 'Улица не найдена. Введите точное название улицы из списка DTEK.');
                        }
                    }
                    
                    session.street = text;
                    session.step = 'houseNumber';
                    bot.sendMessage(chatId, 'Введите номер дома.');
                    break;
                    
                case 'houseNumber':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, 'Ошибка: номер дома не может быть пустым.');
                    }
                    
                    session.houseNumber = text;
                    await db.saveAddress(chatId, session.city, session.street, session.houseNumber, 'dtek_only');
                    
                    bot.sendMessage(chatId, `Адрес сохранен: ${session.city}, ${session.street}, ${session.houseNumber}\n\n⚡ Для информации об отключениях используйте /dtek\n🔌 Для автоматического мониторинга подключите устройство для отправки пингов`);
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
    
    if (await shouldSkipChat(chatId)) return;
    
    if (data.startsWith('select_city_')) {
        const index = parseInt(data.replace('select_city_', ''));
        if (userSessions[chatId]?.citySuggestions?.[index]) {
            const city = userSessions[chatId].citySuggestions[index].item;
            userSessions[chatId] = { step: 'street', city: city };
            bot.sendMessage(chatId, 'Введите название улицы.');
        }
    } else if (data.startsWith('select_street_')) {
        const index = parseInt(data.replace('select_street_', ''));
        if (userSessions[chatId]?.streetSuggestions?.[index]) {
            const street = userSessions[chatId].streetSuggestions[index].item;
            userSessions[chatId].street = street;
            userSessions[chatId].step = 'houseNumber';
            bot.sendMessage(chatId, 'Введите номер дома.');
        }
    }
    bot.answerCallbackQuery(query.id);
});

// Запуск сервера
const PORT = process.env.PORT || 5002;

(async () => {
    try {
        await db.initialize();
        logger.info('Google Sheets подключен');
        
        if (WEBHOOK_URL) {
            await bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
            logger.info(`Webhook установлен: ${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
        }
        
        app.listen(PORT, () => logger.info(`Сервер запущен на порту ${PORT}`));
        
        setInterval(checkLightsStatus, LIGHTS_CHECK_INTERVAL_MS);
        logger.info('Проверка состояния по пингам запущена (каждые 60 секунд)');
        
        setInterval(checkDtekStatus, DTEK_CHECK_INTERVAL_MS);
        logger.info('DTEK проверка запущена (каждые 15 минут)');
        
        setTimeout(() => {
            logger.info('🔄 Выполняем первоначальную проверку состояния...');
            checkLightsStatus();
        }, 2000);
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();