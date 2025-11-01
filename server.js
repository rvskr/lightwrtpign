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

// Получение информации DTEK
async function getDtekInfo(chatId) {
    const row = await db.getLightState(chatId);
    if (!row?.city || !row?.street || !row?.house_number) {
        return 'Адрес не настроен. Используйте /address для настройки.';
    }
    
    const { city, street, house_number } = row;
    try {
        const result = await fetchData(city, street, house_number);
        if (!result) return `Не удалось получить данные для ${city}, ${street}, ${house_number}.`;
        
        const { data, updateTimestamp } = result;
        const houseData = data[house_number] || {};
        
        if (!houseData.sub_type) {
            return `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}`;
        }
        
        return `Обновлено: ${updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nТип: ${houseData.sub_type || 'Не указано'}\nНачало: ${houseData.start_date || 'Не указано'}\nОкончание: ${houseData.end_date || 'Не указано'}\nТип причины: ${houseData.sub_type_reason?.join(', ') || 'Не указано'}`;
    } catch (error) {
        logger.error('Ошибка получения данных DTEK:', error);
        return 'Ошибка при получении данных.';
    }
}

// Обновление закрепленного сообщения
async function updatePinnedMessage(chatId, message) {
    if (await shouldSkipChat(chatId)) return;
    
    const row = await db.getLightState(chatId);
    const mode = row?.mode;
    
    if (mode === 'dtek_only') return; // В режиме dtek_only не используем pinned сообщения
    
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

function getCurrentStatusMessage(row) {
    const currentDuration = DateTime.now().diff(parseDateTime(row.light_start_time));
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const duration = currentDuration.toFormat('d\'д\' h\'ч\' m\'мин\' s\'с\'');
    return `${icon} Свет ${state}\n⏱${duration}`;
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
    
    // Переключение с dtek_only на full при первом пинге
    if (row.mode === 'dtek_only') {
        await db.setMode(chatId, 'full');
        logger.info(`Режим переключен с dtek_only на full для ${chatId}`);
        return bot.sendMessage(chatId, '🔄 Режим переключен на полноценный мониторинг\n💡 Свет ВКЛЮЧЕН');
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

// Проверка DTEK-only режима
async function checkDtekOnlyStatus() {
    try {
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        
        for (const row of rows) {
            if (row.mode !== 'dtek_only' || row.ignored || !row.city?.trim()) continue;
            
            const lastDtekCheck = row.last_ping_time ? parseDateTime(row.last_ping_time) : DateTime.now().minus({ minutes: 16 });
            const minutesSinceLastCheck = now.diff(lastDtekCheck).as('minutes');
            
            if (minutesSinceLastCheck >= 15) {
                await db.saveLightState(row.chat_id, now, false, now, null);
                const dtekMessage = await getDtekInfo(row.chat_id);
                await bot.sendMessage(row.chat_id, `📊 DTEK информация (автоматическая проверка):\n${dtekMessage}`)
                    .catch((error) => logger.error(`Ошибка отправки DTEK: ${error}`));
                logger.info(`DTEK проверка выполнена для ${row.chat_id} (режим dtek_only, прошло ${Math.round(minutesSinceLastCheck)} минут)`);
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
            if (row.ignored || !row.city?.trim() || row.mode !== 'full') continue;
            
            const hasDeviceConnected = row.last_ping_time?.trim() && row.light_start_time?.trim();
            if (!hasDeviceConnected) continue;
            
            const lastPingTime = parseDateTime(row.last_ping_time);
            const timeSinceLastPing = now.diff(lastPingTime).as('seconds');
            
            if (timeSinceLastPing > 180 && row.light_state) {
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
    const mode = row.mode;
    
    // Адрес не настроен
    if (!hasAddress) {
        return bot.sendMessage(chatId, '📍 Адрес не настроен\n\n💡 Для получения информации об отключениях используйте /address для настройки адреса\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов');
    }
    
    // DTEK-only режим
    if (mode === 'dtek_only') {
        const hasDeviceConnected = row.last_ping_time?.trim() && row.light_start_time?.trim();
        const dtekMessage = await getDtekInfo(chatId);
        
        if (!hasDeviceConnected) {
            return bot.sendMessage(chatId, `📊 Режим: Только DTEK (ожидание устройства)\n🏠 ${row.city}, ${row.street}, ${row.house_number}\n\n⏳ Ожидание подключения устройства для полноценного мониторинга\n\n${dtekMessage}`);
        } else {
            return bot.sendMessage(chatId, `📊 Режим: Только DTEK\n🏠 ${row.city}, ${row.street}, ${row.house_number}\n\n${dtekMessage}`);
        }
    }
    
    // Полноценный режим без подключенного устройства
    const hasDeviceConnected = row.last_ping_time?.trim() && row.light_start_time?.trim() && row.last_ping_time !== row.light_start_time;
    if (!hasDeviceConnected) {
        return bot.sendMessage(chatId, `📍 Адрес настроен для мониторинга\n🏠 ${row.city}, ${row.street}, ${row.house_number}\n\n💡 Можете использовать /dtek для получения информации об отключениях\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов`);
    }
    
    // Полноценный режим с подключенным устройством
    const lightStartTime = parseDateTime(row.light_start_time);
    const currentDuration = DateTime.now().diff(lightStartTime);
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const prevDuration = row.previous_duration || 'неизвестно';
    const message = `${icon} Свет ${state}\n⏱ Текущий статус: ${currentDuration.toFormat('hh:mm:ss')}\n📊 Предыдущий статус: ${prevDuration}`;
    
    bot.sendMessage(chatId, message);
    logger.info(`Статус отправлен для ${chatId} (время: ${Date.now() - startTime} ms)`);
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId) || await shouldSkipChat(chatId)) return;
    
    userSessions[chatId] = { step: 'city' };
    bot.sendMessage(chatId, 'Пожалуйста, введите название города.');
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
                    
                    bot.sendMessage(chatId, `Адрес сохранен: ${session.city}, ${session.street}, ${session.houseNumber}\n📊 Режим: Только DTEK (проверка отключений)\n\n🔄 После подключения устройства режим автоматически переключится на полноценный мониторинг`);
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
        
        setInterval(checkLightsStatus, 60000);
        logger.info('Внутренняя проверка света запущена (каждые 60 секунд)');
        
        setInterval(checkDtekOnlyStatus, 15 * 60 * 1000);
        logger.info('DTEK-only проверка запущена (каждые 15 минут)');
        
        setTimeout(() => {
            logger.info('🔄 Выполняем первоначальную проверку состояния...');
            checkLightsStatus();
        }, 2000);
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();