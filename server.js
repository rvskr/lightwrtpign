const express = require('express');
const dotenv = require('dotenv');
const { DateTime } = require('luxon');
const winston = require('winston');
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes } = require('sequelize');

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

// Подключение к PostgreSQL
const sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    },
    logging: false
});

// Модель для хранения состояния света
const LightState = sequelize.define('LightState', {
    chat_id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    last_ping_time: {
        type: DataTypes.DATE,
        allowNull: false
    },
    light_state: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    light_start_time: {
        type: DataTypes.DATE,
        allowNull: false
    },
    previous_duration: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    tableName: 'light_states',
    timestamps: false
});

function sendTelegramMessage(chatId, message) {
    return bot.sendMessage(chatId, message)
        .then(() => logger.info(`Сообщение отправлено: ${message}`))
        .catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
}

async function saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
    try {
        await LightState.upsert({
            chat_id: chatId,
            last_ping_time: lastPingTime.toJSDate(),
            light_state: lightState,
            light_start_time: lightStartTime.toJSDate(),
            previous_duration: previousDuration ? previousDuration.toFormat("hh:mm:ss") : null
        });
        logger.info(`Данные для chat_id ${chatId} сохранены в базу`);
    } catch (error) {
        logger.error(`Ошибка сохранения данных в базу: ${error.message}`);
    }
}

async function getLightState(chatId) {
    try {
        const data = await LightState.findOne({
            where: { chat_id: chatId }
        });
        return data ? data.toJSON() : null;
    } catch (error) {
        logger.error(`Ошибка чтения данных из базы: ${error.message}`);
        return null;
    }
}

async function updatePingTime(chatId) {
    const now = DateTime.now();
    logger.info(`Получен пинг от ${chatId}`);
    
    const row = await getLightState(chatId);
    if (!row) {
        await saveLightState(chatId, now, true, now, null);
        return sendTelegramMessage(chatId, `Привет! Свет включен.`);
    }

    const lightStartTime = DateTime.fromISO(row.light_start_time);
    const previousDuration = now.diff(lightStartTime);

    if (row.light_state) {  // Если свет уже включен
        await saveLightState(chatId, now, true, lightStartTime, null);
    } else {  // Если свет выключен
        await saveLightState(chatId, now, true, now, previousDuration);
        await sendTelegramMessage(chatId, `Свет ВКЛЮЧИЛИ. Был выключен на протяжении ${previousDuration.toFormat('hh:mm:ss')}.`);
    }
}

// Endpoint для периодической проверки состояния (вызывается внешним cron)
app.get('/check-lights', async (req, res) => {
    try {
        const now = DateTime.now();
        const rows = await LightState.findAll();

        for (const row of rows) {
            const chatId = row.chat_id;
            const lastPingTime = DateTime.fromJSDate(new Date(row.last_ping_time));
            
            if (now.diff(lastPingTime).as('seconds') > 180 && row.light_state) {
                const lightStartTime = DateTime.fromJSDate(new Date(row.light_start_time));
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

    const lightState = row.light_state ? 'включен' : 'выключен';
    const durationCurrent = DateTime.now().diff(DateTime.fromJSDate(new Date(row.light_start_time)));
    const previousDuration = row.previous_duration || 'неизвестно';
    const responseMessage = `Свет ${lightState} на протяжении ${durationCurrent.toFormat('hh:mm:ss')}. Предыдущий статус длился ${previousDuration}.`;

    bot.sendMessage(chatId, responseMessage);
    logger.info(`Статус отправлен для группы ${chatId}`);
});

const PORT = process.env.PORT || 5002;

// Инициализация базы данных и запуск сервера
sequelize.sync().then(async () => {
    logger.info('База данных подключена');
    
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
}).catch(error => {
    logger.error(`Ошибка подключения к базе данных: ${error.message}`);
});
