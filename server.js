const express = require('express');
const dotenv = require('dotenv');
const { DateTime } = require('luxon');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const SheetsDB = require('./sheets');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://your-app.onrender.com
const bot = new TelegramBot(TELEGRAM_TOKEN);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs.log' }),
        new winston.transports.Console()
    ],
});

// Инициализация Google Sheets
const db = new SheetsDB(logger);

function sendTelegramMessage(chatId, message) {
    return bot.sendMessage(chatId, message)
        .then(() => logger.info(`Сообщение отправлено: ${message}`))
        .catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
}

// Функция для парсинга времени в обоих форматах (старый ISO и новый читаемый)
function parseDateTime(timeString) {
    if (!timeString) return null;
    
    // Пробуем новый формат: "dd.MM.yyyy HH:mm:ss"
    let dt = DateTime.fromFormat(timeString, 'dd.MM.yyyy HH:mm:ss');
    if (dt.isValid) return dt;
    
    // Пробуем старый формат ISO: "2025-10-31T23:44:01.053+00:00"
    dt = DateTime.fromISO(timeString);
    if (dt.isValid) return dt;
    
    logger.error(`Не удалось распарсить время: ${timeString}`);
    return DateTime.now(); // Возвращаем текущее время как fallback
}

async function saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
    await db.saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration);
}

async function getLightState(chatId) {
    return await db.getLightState(chatId);
}

async function updatePingTime(chatId) {
    const now = DateTime.now();
    logger.info(`Получен пинг от ${chatId}`);
    
    const row = await getLightState(chatId);
    if (!row) {
        await saveLightState(chatId, now, true, now, null);
        return sendTelegramMessage(chatId, `Привет! Свет включен.`);
    }

    // Парсим время (поддерживаем оба формата)
    const lightStartTime = parseDateTime(row.light_start_time);
    const previousDuration = now.diff(lightStartTime);
    
    // Конвертируем light_state в boolean (из Google Sheets приходит строка)
    const isLightOn = row.light_state === true || row.light_state === 'true';

    if (isLightOn) {  // Если свет уже включен
        await saveLightState(chatId, now, true, lightStartTime, null);
        logger.info(`Свет уже включен, обновлен last_ping_time`);
    } else {  // Если свет выключен
        await saveLightState(chatId, now, true, now, previousDuration);
        await sendTelegramMessage(chatId, `Свет ВКЛЮЧИЛИ. Был выключен на протяжении ${previousDuration.toFormat('hh:mm:ss')}.`);
    }
}

// Endpoint для периодической проверки состояния (вызывается внешним cron)
app.get('/check-lights', async (req, res) => {
    try {
        const now = DateTime.now();
        const rows = await db.getAllLightStates();

        for (const row of rows) {
            const chatId = row.chat_id;
            // Парсим время (поддерживаем оба формата)
            const lastPingTime = parseDateTime(row.last_ping_time);
            
            // Конвертируем light_state в boolean
            const isLightOn = row.light_state === true || row.light_state === 'true';
            
            if (now.diff(lastPingTime).as('seconds') > 180 && isLightOn) {
                const lightStartTime = parseDateTime(row.light_start_time);
                const previousDuration = now.diff(lightStartTime);
                await saveLightState(chatId, now, false, now, previousDuration);
                await sendTelegramMessage(chatId, `Свет ВЫКЛЮЧИЛИ. Был включен на протяжении ${previousDuration.toFormat('hh:mm:ss')}.`);
            }
        }
        
        res.json({ status: 'ok', checked: rows.length });
    } catch (error) {
        logger.error(`Ошибка проверки состояния: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post('/ping', (req, res) => {
    const chatId = req.body.chat_id || 'нет chat_id';
    updatePingTime(chatId);
    res.send("Ping received!");
});

app.get('/ping', (req, res) => {
    const chatId = req.query.chat_id || 'нет chat_id';
    updatePingTime(chatId);
    res.send("Ping received!");
});

// Дополнительный endpoint для устройств без SSL (небезопасный, но работает)
app.get('/p', (req, res) => {
    const chatId = req.query.c || req.query.chat_id || 'нет chat_id';
    updatePingTime(chatId);
    res.send("OK");
});

// Webhook endpoint для Telegram
app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Обработчик команды /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info(`Команда /status получена от группы с chat_id ${chatId}`);

    const row = await getLightState(chatId);
    if (!row) {
        return bot.sendMessage(chatId, `Данных для chat_id ${chatId} не найдено.`);
    }

    // Конвертируем light_state в boolean
    const isLightOn = row.light_state === true || row.light_state === 'true';
    const lightState = isLightOn ? 'включен' : 'выключен';
    // Парсим время (поддерживаем оба формата)
    const durationCurrent = DateTime.now().diff(parseDateTime(row.light_start_time));
    const previousDuration = row.previous_duration || 'неизвестно';
    const responseMessage = `Свет ${lightState} на протяжении ${durationCurrent.toFormat('hh:mm:ss')}. Предыдущий статус длился ${previousDuration}.`;

    bot.sendMessage(chatId, responseMessage);
    logger.info(`Статус отправлен для группы ${chatId}`);
});

const PORT = process.env.PORT || 5002;

// Инициализация Google Sheets и запуск сервера
(async () => {
    try {
        await db.initialize();
        logger.info('Google Sheets подключен');
        
        // Установка webhook для Telegram
        if (WEBHOOK_URL) {
            try {
                await bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
                logger.info(`Webhook установлен: ${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);
            } catch (error) {
                logger.error(`Ошибка установки webhook: ${error.message}`);
            }
        }
        
        app.listen(PORT, () => {
            logger.info(`Сервер запущен на порту ${PORT}`);
            sendTelegramMessage('558625598', `Привет! Бот запущен и готов к работе`);
        });
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();
