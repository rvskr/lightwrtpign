const express = require('express');
const dotenv = require('dotenv');
const { DateTime } = require('luxon');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const SheetsDB = require('./sheets');
const fetchData = require('./fetchData.cjs');
const data = require('./data.js');
const Fuse = require('fuse.js');

const cities = Object.keys(data.streets);
const fuseCities = new Fuse(cities, { threshold: 0.4 });

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
    transports: [
        new winston.transports.Console()
    ],
});

const db = new SheetsDB(logger);

async function getDtekInfo(chatId) {
    const row = await db.getLightState(chatId);
    if (!row || !row.city || !row.street || !row.house_number) {
        return 'Адрес не настроен. Используйте /address для настройки.';
    }
    const { city, street, house_number } = row;
    try {
        const result = await fetchData(city, street, house_number);
        if (result) {
            const { data, updateTimestamp } = result;
            const houseData = data[house_number] || {};
            if (!houseData.sub_type) {
                return `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}`;
            }
            return `Обновлено: ${updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nТип: ${houseData.sub_type || 'Не указано'}\nНачало: ${houseData.start_date || 'Не указано'}\nОкончание: ${houseData.end_date || 'Не указано'}\nТип причины: ${houseData.sub_type_reason?.join(', ') || 'Не указано'}`;
        } else {
            return `Не удалось получить данные для ${city}, ${street}, ${house_number}.`;
        }
    } catch (error) {
        logger.error('Ошибка получения данных DTEK:', error);
        return 'Ошибка при получении данных.';
    }
}

function getCurrentStatusMessage(row) {
    const currentDuration = DateTime.now().diff(parseDateTime(row.light_start_time));
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const duration = currentDuration.toFormat('d\'д\' h\'ч\' m\'мин\' s\'с\'');
    return `${icon} Свет ${state}\n⏱${duration}`;
}

async function updatePinnedMessage(chatId, message) {
    try {
        const row = await db.getLightState(chatId);
        if (!row) return;
        const messageToSend = message || getCurrentStatusMessage(row);
        const pinnedMessageId = row.pinned_message_id;
        if (pinnedMessageId) {
            try {
                await bot.editMessageText(messageToSend, { chat_id: chatId, message_id: pinnedMessageId });
                if (message) logger.info(`Сообщение обновлено: ${message}`);
            } catch (error) {
                if (!error.message.includes('message is not modified')) throw error;
            }
        } else {
            const sentMsg = await bot.sendMessage(chatId, messageToSend);
            await bot.pinChatMessage(chatId, sentMsg.message_id);
            await db.savePinnedMessageId(chatId, sentMsg.message_id);
            if (message) logger.info(`Сообщение отправлено и закреплено: ${message}`);
        }
    } catch (error) {
        logger.error(`Ошибка обновления закрепленного сообщения для ${chatId}: ${error.message}`);
    }
}

function parseDateTime(timeString) {
    const cleanString = timeString.startsWith("'") ? timeString.substring(1) : timeString;
    const formats = ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy H:mm:ss'];
    for (const fmt of formats) {
        const dt = DateTime.fromFormat(cleanString, fmt);
        if (dt.isValid) return dt;
    }
    const dt = DateTime.fromISO(cleanString);
    if (dt.isValid) return dt;
    logger.error(`Не удалось распарсить время: ${timeString}`);
    return DateTime.now();
}

async function notifyStatusChange(chatId, statusMessage) {
    await updatePinnedMessage(chatId);
    await bot.sendMessage(chatId, statusMessage).then(() => logger.info(`Сообщение отправлено`)).catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
}

async function updatePingTime(chatId) {
    const now = DateTime.now();
    logger.info(`Получен пинг от ${chatId}`);
    const row = await db.getLightState(chatId);
    if (!row) {
        await db.saveLightState(chatId, now, true, now, null);
        await updatePinnedMessage(chatId);
        return bot.sendMessage(chatId, `💡 Свет ВКЛЮЧЕН`).then(() => logger.info(`Сообщение отправлено`)).catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
    }
    const lightStartTime = parseDateTime(row.light_start_time);
    const isLightOn = row.light_state;
    if (isLightOn) {
        await db.saveLightState(chatId, now, true, lightStartTime, null);
        await updatePinnedMessage(chatId);
        logger.info(`Свет включен, обновлен last_ping_time для ${chatId}`);
    } else {
        const offDuration = now.diff(lightStartTime);
        await db.saveLightState(chatId, now, true, now, null);
        await notifyStatusChange(chatId, `💡 Свет ВКЛЮЧЕН\n⏸ Был выключен: ${offDuration.toFormat('hh:mm:ss')}`);
        logger.info(`Свет включен для ${chatId} (был выключен ${offDuration.toFormat('hh:mm:ss')})`);
    }
}

async function checkLightsStatus() {
    try {
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        for (const row of rows) {
            const lastPingTime = parseDateTime(row.last_ping_time);
            const timeSinceLastPing = now.diff(lastPingTime).as('seconds');
            if (timeSinceLastPing > 180 && row.light_state) {
                const lightStartTime = parseDateTime(row.light_start_time);
                const onDuration = now.diff(lightStartTime);
                await db.saveLightState(row.chat_id, now, false, now, onDuration);
                await notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН\n⏸ Был включен: ${onDuration.toFormat('hh:mm:ss')}`);
                logger.info(`Свет выключен для ${row.chat_id} (нет пинга ${Math.round(timeSinceLastPing)}s)`);
                // Запрос информации от DTEK
                const dtekMessage = await getDtekInfo(row.chat_id);
                await bot.sendMessage(row.chat_id, dtekMessage).catch((error) => logger.error(`Ошибка отправки DTEK: ${error}`));
            } else {
                await updatePinnedMessage(row.chat_id);
                logger.info(`Мастер-сообщение обновлено для ${row.chat_id} (${row.light_state ? 'включен' : 'выключен'})`);
            }
        }
    } catch (error) {
        logger.error(`Ошибка проверки: ${error.message}`);
    }
}

app.get('/check-lights', async (req, res) => {
    await checkLightsStatus();
    res.json({ status: 'ok', message: 'Проверка выполнена' });
});

const handlePing = (req, res) => {
    const chatId = req.body?.chat_id || req.query?.c || req.query?.chat_id;
    if (chatId) updatePingTime(chatId);
    res.send("OK");
};

app.post('/ping', handlePing);
app.get('/ping', handlePing);
app.get('/p', handlePing);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

bot.onText(/\/status(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`Команда /status от ${chatId} в чате типа ${msg.chat.type}`);
    const row = await db.getLightState(chatId);
    if (!row) {
        return bot.sendMessage(chatId, `❌ Нет данных для chat_id ${chatId}`);
    }
    const currentDuration = DateTime.now().diff(parseDateTime(row.light_start_time));
    const icon = row.light_state ? '💡' : '🌑';
    const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
    const prevDuration = row.previous_duration || 'неизвестно';
    const message = `${icon} Свет ${state}\n⏱ Текущий статус: ${currentDuration.toFormat('hh:mm:ss')}\n📊 Предыдущий статус: ${prevDuration}`;
    bot.sendMessage(chatId, message);
    logger.info(`Статус отправлен для ${chatId}`);
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`Команда /address от ${chatId} в чате типа ${msg.chat.type}`);
    userSessions[chatId] = { step: 'city' };
    bot.sendMessage(chatId, 'Пожалуйста, введите название города.');
});

bot.onText(/\/dtek(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`Команда /dtek от ${chatId} в чате типа ${msg.chat.type}`);
    const message = await getDtekInfo(chatId);
    bot.sendMessage(chatId, message);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    console.log(`Сообщение: "${text}" от ${chatId} в чате типа ${msg.chat.type}`);

    // Пропускаем команды
    if (text && (/^\/status(?:@\w+)?/.test(text) || /^\/address(?:@\w+)?/.test(text) || /^\/dtek(?:@\w+)?/.test(text))) {
        return;
    }

    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        console.log(`Обработка сессии для ${chatId}, шаг: ${session.step}`);
        try {
            switch (session.step) {
                case 'city':
                    if (text.trim() === '') {
                        bot.sendMessage(chatId, 'Ошибка: название города не может быть пустым.');
                        return;
                    }
                    if (!data.streets[text]) {
                        const results = fuseCities.search(text);
                        if (results.length > 0) {
                            const suggestions = results.slice(0, 5);
                            session.citySuggestions = suggestions;
                            const keyboard = {
                                inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_city_${i}` }])
                            };
                            bot.sendMessage(chatId, `Город не найден. Выберите вариант:`, { reply_markup: keyboard });
                        } else {
                            bot.sendMessage(chatId, 'Город не найден. Введите точное название города из списка DTEK.');
                        }
                        return;
                    }
                    session.city = text;
                    session.step = 'street';
                    console.log(`Город установлен: ${text} для ${chatId}`);
                    bot.sendMessage(chatId, 'Введите название улицы.');
                    break;
                case 'street':
                    if (text.trim() === '') {
                        bot.sendMessage(chatId, 'Ошибка: название улицы не может быть пустым.');
                        return;
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
                            bot.sendMessage(chatId, `Улица не найдена. Выберите вариант:`, { reply_markup: keyboard });
                        } else {
                            bot.sendMessage(chatId, 'Улица не найдена. Введите точное название улицы из списка DTEK.');
                        }
                        return;
                    }
                    session.street = text;
                    session.step = 'houseNumber';
                    console.log(`Улица установлена: ${text} для ${chatId}`);
                    bot.sendMessage(chatId, 'Введите номер дома.');
                    break;
                case 'houseNumber':
                    if (text.trim() === '') {
                        bot.sendMessage(chatId, 'Ошибка: номер дома не может быть пустым.');
                        return;
                    }
                    session.houseNumber = text;
                    session.step = 'completed';
                    await db.saveAddress(chatId, session.city, session.street, session.houseNumber);
                    console.log(`Адрес сохранен: ${session.city}, ${session.street}, ${text} для ${chatId}`);
                    bot.sendMessage(chatId, `Адрес сохранен: ${session.city}, ${session.street}, ${session.houseNumber}`);
                    delete userSessions[chatId];
                    break;
                default:
                    bot.sendMessage(chatId, 'Неверный этап. Начните с /address.');
                    delete userSessions[chatId];
                    break;
            }
        } catch (error) {
            console.error(`Ошибка в сессии для ${chatId}: ${error.message}`);
            bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
            delete userSessions[chatId];
        }
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('select_city_')) {
        const index = parseInt(data.replace('select_city_', ''));
        if (userSessions[chatId] && userSessions[chatId].citySuggestions && userSessions[chatId].citySuggestions[index]) {
            const city = userSessions[chatId].citySuggestions[index].item;
            userSessions[chatId] = { step: 'street', city: city };
            console.log(`Город выбран: ${city} для ${chatId}`);
            bot.sendMessage(chatId, 'Введите название улицы.');
        }
        bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('select_street_')) {
        const index = parseInt(data.replace('select_street_', ''));
        if (userSessions[chatId] && userSessions[chatId].streetSuggestions && userSessions[chatId].streetSuggestions[index]) {
            const street = userSessions[chatId].streetSuggestions[index].item;
            userSessions[chatId].street = street;
            userSessions[chatId].step = 'houseNumber';
            console.log(`Улица выбрана: ${street} для ${chatId}`);
            bot.sendMessage(chatId, 'Введите номер дома.');
        }
        bot.answerCallbackQuery(query.id);
    }
});

const userSessions = {};
const previousStates = {};

const PORT = process.env.PORT || 5002;

(async () => {
    try {
        await db.initialize();
        logger.info('Google Sheets подключен');
        if (WEBHOOK_URL) {
            try {
                await bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
                logger.info(`Webhook установлен: ${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
            } catch (error) {
                logger.error(`Ошибка установки webhook: ${error.message}`);
            }
        }
        app.listen(PORT, () => logger.info(`Сервер запущен на порту ${PORT}`));
        logger.info('Запускаем внутреннюю проверку света...');
        setInterval(checkLightsStatus, 60000);
        logger.info('Внутренняя проверка света запущена (каждые 60 секунд)');
        setTimeout(() => {
            logger.info('🔄 Выполняем первоначальную проверку состояния...');
            checkLightsStatus();
        }, 2000);
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();
