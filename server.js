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
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

// Константы
const RATE_LIMIT_MS = 1000;
const PING_TIMEOUT_SEC = 180;
const LIGHTS_CHECK_INTERVAL_MS = 60_000;
const DTEK_CHECK_MINUTES = 15;
const PARALLEL_LIMIT = parseInt(process.env.PARALLEL_LIMIT || '50', 10);
const TELEGRAM_LIMIT = 25;
const MIN_PINNED_UPDATE_MS = 30_000;
const DTEK_CACHE_TTL_MS = DTEK_CHECK_MINUTES * 60_000;

// Режимы работы
const MODE = {
    NONE: 'none',
    PING: 'ping',
    DTEK: 'dtek_only',
    FULL: 'full'
};

const applyAddressUpdate = async (chatId, city, street, houseNumber) => {
    await db.saveAddress(chatId, city, street, houseNumber);
    addressUpdatedTimestamps.set(String(chatId), Date.now());
    dtekCheckTimestamps.set(String(chatId), Date.now());
    const current = await db.getLightState(chatId);
    await updateModeIfNeeded(chatId, current?.mode, current);
    const dtekMsg = await getDtekInfo(chatId, false, false);
    const addressText = houseNumber?.trim()
        ? `📍 Адрес сохранен:\n${city}, ${street}, ${houseNumber}`
        : `📍 Адрес сохранен:\n${city}, ${street} (вся улица)`;
    await bot.sendMessage(chatId, `${addressText}\n\n📊 DTEK (текущий статус):\n${dtekMsg}`);
    await updatePinnedMessage(chatId, undefined, true, current);
};

const db = new SheetsDB(logger);
const cities = Object.keys(data.streets);
const fuseCities = new Fuse(cities, { threshold: 0.4 });
const userSessions = {};
const pinnedUpdateTimestamps = new Map();
const dtekCheckTimestamps = new Map();
const addressUpdatedTimestamps = new Map(); // chatId (string) -> ts(ms)
const modeWriteMemo = new Map(); // chatId -> { mode, t }
const userRateLimits = {};
const parallelLimit = pLimit(PARALLEL_LIMIT);

const dtekCache = new Map();

// Анти-дублирование отправки одинаковых сообщений
const lastSentMessage = new Map(); // chatId -> { text, t }
const sendMessageDedup = async (chatId, text, dedupWindowMs = 10000) => {
    const prev = lastSentMessage.get(chatId);
    const now = Date.now();
    if (prev && prev.text === text && (now - prev.t) < dedupWindowMs) return null;
    const res = await bot.sendMessage(chatId, text);
    lastSentMessage.set(chatId, { text, t: now });
    return res;
};

// Очередь Telegram сообщений
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
            try {
                await Promise.all(batch.map(({ fn, resolve, reject }) => 
                    fn().then(resolve).catch(reject)
                ));
            } catch (e) {
                logger?.error?.('TelegramQueue batch error', e);
            }
            if (this.queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        this.processing = false;
    }
}

// Helpers
const dtekKey = (city, street, house_number) => `${city}|${street}|${house_number || ''}`;

const getDtekSummaryCached = async (city, street, house_number, opts = {}) => {
    const allowFetch = opts.allowFetch !== false;
    const key = dtekKey(city, street, house_number);
    const cached = dtekCache.get(key);
    const now = Date.now();
    if (cached && (now - cached.t) < DTEK_CACHE_TTL_MS) return cached.v;
    if (!allowFetch) return cached ? cached.v : null;
    const summary = await fetchAndSummarizeDtek(city, street, house_number);
    dtekCache.set(key, { v: summary, t: now });
    return summary;
};

const getDtekSummaryForRow = async (row) => {
    const houseNumber = row.house_number?.trim() || '';
    return await getDtekSummaryCached(row.city, row.street, houseNumber, { allowFetch: true });
};

const isDtekCheckDue = (chatId) => {
    const lastTs = dtekCheckTimestamps.get(String(chatId)) || 0;
    return ((Date.now() - lastTs) / 60000) >= DTEK_CHECK_MINUTES;
};

const markDtekChecked = (chatId) => {
    dtekCheckTimestamps.set(String(chatId), Date.now());
};

const secondsSinceLastPing = (row, now) => {
    return row.last_ping_time?.trim() ? now.diff(parseDateTime(row.last_ping_time)).as('seconds') : Number.POSITIVE_INFINITY;
};

const applyDtekSummary = async (row, summary, now) => {
    const startTime = parseDateTime(row.light_start_time);
    const changed = (summary.inferredOff === row.light_state);
    if (changed) {
        if (summary.inferredOff) {
            await db.saveLightStatePreservePing(row.chat_id, false, now, now.diff(startTime));
            await notifyStatusChange(row.chat_id, '🌑 Свет ВЫКЛЮЧЕН');
        } else {
            await db.saveLightStatePreservePing(row.chat_id, true, now, null);
            await notifyStatusChange(row.chat_id, '💡 Свет ВКЛЮЧЕН');
        }
    } else {
        // Обновляем время последней проверки/пин, но не спамим
        await db.saveLightStatePreservePing(row.chat_id, row.light_state, startTime, null);
        updatePinnedMessage(row.chat_id, undefined, false, row);
    }
    return { changed, message: summary.message };
};

const handlePingTimeout = async (row, now, mode) => {
    const secs = secondsSinceLastPing(row, now);
    if (secs > PING_TIMEOUT_SEC && row.light_state) {
        const onDuration = now.diff(parseDateTime(row.light_start_time));
        await db.saveLightState(row.chat_id, now, false, now, onDuration);
        await notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН\n⏸ Был включен: ${onDuration.toFormat('hh:mm:ss')}`);
        if (mode === MODE.FULL) {
            const dtekMsg = await getDtekInfo(row.chat_id, false, false);
            await telegramQueue.add(() => sendMessageDedup(row.chat_id, `📊 DTEK (авто):\n${dtekMsg}`));
        }
        return true;
    }
    updatePinnedMessage(row.chat_id, undefined, false, row);
    return false;
};

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

const hasDeviceConnected = (row) => {
    if (!row) return false;
    const last = row.last_ping_time?.trim();
    if (!last) return false;
    const pingTime = parseDateTime(last);
    if (!pingTime || !pingTime.isValid) return false;
    const now = DateTime.now();
    const secsSincePing = now.diff(pingTime, 'seconds').seconds;
    return secsSincePing < (PING_TIMEOUT_SEC + 5);
};

const formatMessage = async (row, opts = {}) => {
    const short = typeof opts === 'boolean' ? opts : !!opts.short;
    const includeDtek = typeof opts === 'object' ? (opts.includeDtek ?? true) : true;
    // Вычисляем режим без записи в БД, чтобы избежать дублей
    const mode = determineMode(row);

    // Возможно понадобится DTEK для режима dtek_only
    let dtekSummary = null;
    if (includeDtek && mode !== MODE.PING && row.city && row.street) {
        const houseNumber = row.house_number?.trim() || '';
        const allowFetch = !(typeof opts === 'object' && opts.useDtekCacheOnly);
        dtekSummary = await getDtekSummaryCached(row.city, row.street, houseNumber, { allowFetch });
    }

    // Эффективное состояние для заголовка
    const effectiveLight = (mode === MODE.DTEK && dtekSummary)
        ? !dtekSummary.inferredOff
        : !!row.light_state;

    const icon = effectiveLight ? '💡' : '🌑';
    const state = effectiveLight ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';

    // Определяем старт времени: при пустом light_start_time и наличии DTEK берём updateTimestamp
    const rowHasStart = !!row.light_start_time?.trim();
    let startDt = rowHasStart ? parseDateTime(row.light_start_time) : null;
    if (!rowHasStart && mode === MODE.DTEK && dtekSummary?.updateTimestamp) {
        const dtekTime = DateTime.fromFormat(dtekSummary.updateTimestamp, 'HH:mm dd.MM.yyyy');
        if (dtekTime?.isValid) {
            startDt = dtekTime;
            // Однократно сохраняем старт по DTEK, не меняя last_ping_time
            try { await db.saveLightStatePreservePing(row.chat_id, effectiveLight, dtekTime, null); } catch {}
        }
    }

    const durationText = startDt
        ? DateTime.now().diff(startDt).toFormat('hh:mm:ss')
        : 'неизвестно';
    const shortDurationText = startDt
        ? DateTime.now().diff(startDt).toFormat("d'd' h'ч' m'мин' s'с'")
        : 'неизвестно';

    if (short) return `${icon} Свет ${state}\n⏱ ${shortDurationText}`;

    let message = `${icon} Свет ${state}\n`;
    message += `⏱ Текущий статус: ${durationText}`;
    if (row.previous_duration?.trim()) {
        message += `\n📊 Предыдущий статус: ${row.previous_duration}`;
    }
    message += `\n\n📡 Режим: ${getModeName(mode)}`;

    // Добавляем DTEK только если он релевантен
    if (includeDtek && dtekSummary?.message) {
        message += `\n\n📊 DTEK:\n${dtekSummary.message}`;
    }

    return message;
};

// Получение и суммирование данных DTEK
async function fetchAndSummarizeDtek(city, street, house_number) {
    try {
        const addressText = house_number ? `${city}, ${street}, ${house_number}` : `${city}, ${street} (вся улица)`;
        const result = await fetchData(city, street, house_number);
        
        if (!result) {
            return { inferredOff: false, message: `Не удалось получить данные для ${addressText}.` };
        }

        const { data, updateTimestamp, resolvedHomeKey, showCurOutageParam } = result;
        const keyToUse = (resolvedHomeKey && data?.[resolvedHomeKey]) ? resolvedHomeKey : house_number;
        const houseData = data[keyToUse] || {};

        if (!houseData.sub_type && !showCurOutageParam) {
            return { inferredOff: false, message: `По адресу ${addressText} отключений нет. Обновлено: ${updateTimestamp}`, updateTimestamp };
        }

        if (!houseData.sub_type && showCurOutageParam) {
            const all = Object.values(data || {});
            const isActive = (x) => !!(x && ((x.sub_type && x.sub_type.trim()) || (x.start_date && x.start_date.trim()) || (x.end_date && x.end_date.trim())));
            const activeEntries = all.filter(isActive);
            
            if (activeEntries.length === 0) {
                return { inferredOff: false, message: `По адресу ${addressText} отключений нет. Обновлено: ${updateTimestamp}`, updateTimestamp };
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

            return {
                inferredOff: true,
                message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${addressText}\nСтатус: Зафиксировано ограничение/отключение по улице\nПричины: ${reasons.length ? reasons.join(', ') : 'Не указано'}\nНачало: ${startText}\nОкончание: ${endText}`,
                updateTimestamp
            };
        }

        return {
            inferredOff: true,
            message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${addressText}\nТип: ${houseData.sub_type || 'Не указано'}\nНачало: ${houseData.start_date || 'Не указано'}\nОкончание: ${houseData.end_date || 'Не указано'}\nТип причины: ${houseData.sub_type_reason?.join(', ') || 'Не указано'}`,
            updateTimestamp
        };
    } catch (error) {
        logger.error('Ошибка получения данных DTEK:', error);
        return { inferredOff: false, message: 'Ошибка при получении данных.' };
    }
}

// Автоматическое определение режима работы
function determineMode(row) {
    if (!row) return 'none';
    
    const hasAddress = !!(row.city?.trim() && row.street?.trim());
    let hasPing = !!(row.last_ping_time?.trim());
    
    logger.debug?.(`[DEBUG] Mode check - hasAddress: ${hasAddress}, hasPing: ${hasPing}, last_ping: ${row.last_ping_time}`);
    
    if (!hasAddress && !hasPing) return MODE.NONE;
    if (!hasAddress && hasPing) return MODE.PING;
    if (hasAddress && !hasPing) return MODE.DTEK;
    if (hasAddress && hasPing) return MODE.FULL;
    
    return MODE.NONE; // fallback
}

// Обновление режима в базе данных при необходимости
async function updateModeIfNeeded(chatId, currentMode, rowHint = null) {
    try {
        const row = rowHint || await db.getLightState(chatId);
        if (!row) return 'none';
        
        const actualMode = determineMode(row);
        
        // Если режим не изменился, возвращаем текущий
        if (currentMode === actualMode) return currentMode;
        
        // Защита от повторных записей в коротком окне
        const memo = modeWriteMemo.get(chatId);
        if (memo && memo.mode === actualMode && (Date.now() - memo.t) < 2000) {
            return actualMode;
        }

        // Обновляем только режим, не трогая другие данные
        const ok = await db.setMode(chatId, actualMode);
        // Обновляем кеш
        db.cache(chatId, { ...row, mode: actualMode });
        db.cache('all', null);
        // Логируем изменение режима
        console.log(`[MODE] Updated mode for ${chatId} from ${currentMode} to ${actualMode}`);
        modeWriteMemo.set(chatId, { mode: actualMode, t: Date.now() });
        
        return actualMode;
    } catch (error) {
        console.error('[MODE] Error updating mode:', error);
        return currentMode || 'none';
    }
}

// Получение информации DTEK
const getDtekInfo = async (chatId, updateState = false, includeModeHeader = true) => {
    try {
        const row = await db.getLightState(chatId);
        if (!row) return 'Профиль не найден. Начните с команды /start';
        
        // Режим вычисляем локально (без записи в БД)
        const mode = determineMode(row);
        
        // Если нет адреса, возвращаем сообщение о необходимости настройки
        if (!row.city || !row.street) {
            const base = 'Для работы с DTEK укажите адрес с помощью команды /address';
            return includeModeHeader ? `📡 Режим: ${getModeName(mode)}\n\n${base}` : base;
        }
        
        // Если режим только пинг, возвращаем соответствующее сообщение
        if (mode === MODE.PING) {
            const lastPing = row.last_ping_time ? `\n⏱ Последний пинг: ${row.last_ping_time}` : '';
            const body = `DTEK проверка отключена, так как настроен мониторинг устройства.${lastPing}`;
            return includeModeHeader ? `📡 Режим: только пинг\n\n${body}` : body;
        }
        
        // Получаем информацию о DTEK
        const summary = await getDtekSummaryForRow(row);
        
        // Обновляем состояние только если не в режиме ping
        if (updateState && mode !== MODE.PING && summary.updateTimestamp) {
            const dtekTime = DateTime.fromFormat(summary.updateTimestamp, 'HH:mm dd.MM.yyyy');
            if (dtekTime.isValid) {
                const newState = !summary.inferredOff;
                await db.saveLightStatePreservePing(chatId, newState, dtekTime, null);
                await updatePinnedMessage(chatId);
            }
        }
        
        // Формируем сообщение с информацией о режиме и статусе DTEK
        const dtekStatus = summary.message || 'Не удалось получить данные DTEK';
        return includeModeHeader ? `📡 Режим: ${getModeName(mode)}\n\n${dtekStatus}` : dtekStatus;
        
    } catch (error) {
        console.error('[DTEK] Error in getDtekInfo:', error);
        return 'Произошла ошибка при получении информации о DTEK. Пожалуйста, попробуйте позже.';
    }
};

// Получение читаемого названия режима
function getModeName(mode) {
    const modes = {
        'none': 'Не настроен',
        'ping': 'Только пинг',
        'dtek_only': 'Только DTEK',
        'full': 'Полный (DTEK + пинг)'
    };
    return modes[mode] || mode;
}

// Обновление закрепленного сообщения
const updatePinnedMessage = async (chatId, message, force = false, rowHint = null) => {
    const row = rowHint || await db.getLightState(chatId);
    if (!row || row.ignored) return;
    
    if (!force) {
        const last = pinnedUpdateTimestamps.get(chatId) || 0;
        if (Date.now() - last < MIN_PINNED_UPDATE_MS) return;
    }
    
    return telegramQueue.add(async () => {
        try {
            const mode = determineMode(row);
            const msg = message || await formatMessage(row, { short: true, includeDtek: mode === MODE.DTEK, useDtekCacheOnly: true });
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
            }
            pinnedUpdateTimestamps.set(chatId, Date.now());
        } catch (error) {
            logger.error(`Ошибка обновления закрепленного сообщения ${chatId}: ${error.message}`);
        }
    });
};

// Уведомления
const notifyStatusChange = async (chatId, statusMessage) => {
    const row = await db.getLightState(chatId);
    if (row?.ignored) return;
    
    updatePinnedMessage(chatId, undefined, true, row);
    await telegramQueue.add(() => sendMessageDedup(chatId, statusMessage));
};

// Обработка пинга
const updatePingTime = async (chatId) => {
    const row = await db.getLightState(chatId);
    if (row?.ignored) return;
    
    const now = DateTime.now();
    
    if (!row) {
        await db.saveLightState(chatId, now, true, now, null);
        // Устанавливаем режим 'ping' для нового пользователя с пингом
        await db.setMode(chatId, MODE.PING);
        
        updatePinnedMessage(chatId);
        return bot.sendMessage(chatId, '💡 Свет ВКЛЮЧЕН\n📡 Режим: Только пинг');
    }
    
    // Обновляем режим на основе текущего состояния
    const mode = await updateModeIfNeeded(chatId, row.mode, row);
    
    const lightStartTime = parseDateTime(row.light_start_time);
    if (row.light_state) {
        await db.saveLightState(chatId, now, true, lightStartTime, null);
        updatePinnedMessage(chatId, undefined, false, row);
    } else {
        const offDuration = now.diff(lightStartTime);
        await db.saveLightState(chatId, now, true, now, null);
        await notifyStatusChange(chatId, 
            `💡 Свет ВКЛЮЧЕН\n` +
            `📡 Режим: ${getModeName(mode)}\n` +
            `⏸ Был выключен: ${offDuration.toFormat('hh:mm:ss')}`);
    }
};

// Проверка состояния света
const checkLightsStatus = async () => {
    try {
        const startTime = Date.now();
        const now = DateTime.now();
        const rows = await db.getAllLightStates();
        
        logger.info(`Начало проверки для ${rows.length} пользователей`);
        
        await Promise.all(rows.map(row => parallelLimit(async () => {
            if (row.ignored || !row.city?.trim()) return;

            const mode = determineMode(row);
            await updateModeIfNeeded(row.chat_id, row.mode, row);

            if (mode === MODE.DTEK) {
                if (isDtekCheckDue(row.chat_id)) {
                    const summary = await getDtekSummaryForRow(row);
                    const res = await applyDtekSummary(row, summary, now);
                    if (res.changed) {
                        await telegramQueue.add(() => sendMessageDedup(row.chat_id, `📊 DTEK (авто):\n${res.message}`));
                    }
                    markDtekChecked(row.chat_id);
                } else {
                    updatePinnedMessage(row.chat_id, undefined, false, row);
                }
            } else if (mode === MODE.FULL || mode === MODE.PING) {
                const switched = await handlePingTimeout(row, now, mode);
                if (!switched) updatePinnedMessage(row.chat_id, undefined, false, row);
            } else {
                // none/ping: просто обновим закреп (адреса нет или только пинг)
                updatePinnedMessage(row.chat_id, undefined, false, row);
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

// Команды бота
bot.onText(/\/start(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        await db.setIgnored(chatId, false);
        await db.initializeUser(chatId);
        await db.saveUserInfo(chatId, {
            first_name: msg.from.first_name,
            last_name: msg.from.last_name,
            username: msg.from.username
        });
        
        const userName = msg.from.first_name || 'Пользователь';
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
        bot.sendMessage(chatId, '🚫 Бот отключен. Для возобновления /start');
    } catch (error) {
        logger.error(`/stop ${chatId}: ${error.message}`);
        bot.sendMessage(chatId, '❌ Ошибка');
    }
});

bot.onText(/\/status(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    try {
        const row = await db.getLightState(chatId);
        if (!row) {
            return bot.sendMessage(chatId, 'Пользователь не найден. Используйте /start');
        }
        
        if (row.ignored) {
            return bot.sendMessage(chatId, '🔕 Уведомления отключены. Используйте /start для активации.');
        }
        
        try {
            // Format the message with current mode and DTEK info
            const message = await formatMessage(row);
            await bot.sendMessage(chatId, message);
        } catch (formatError) {
            logger.error(`Ошибка форматирования сообщения для ${chatId}: ${formatError.message}`);
            // Fallback to a simpler message if formatting fails
            const mode = determineMode(row);
            await bot.sendMessage(chatId, `💡 Свет ${row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}\n📡 Режим: ${getModeName(mode)}`);
        }
        
    } catch (error) {
        logger.error(`Ошибка статуса для ${chatId}: ${error.message}`);
        bot.sendMessage(chatId, 'Произошла ошибка при получении статуса.');
    }
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!checkRateLimit(chatId)) return;
    
    const row = await db.getLightState(chatId);
    if (row?.ignored) return;
    
    userSessions[chatId] = { step: 'city' };
    
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
    
    const row = await db.getLightState(chatId);
    if (row?.ignored) return;
    
    bot.sendMessage(chatId, await getDtekInfo(chatId, true));
});

// Обработка сообщений для сессий
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (text && /^\/(start|stop|status|address|dtek)(?:@\w+)?/.test(text)) return;
    
    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        
        try {
            switch (session.step) {
                case 'city':
                    if (!text?.trim()) {
                        return bot.sendMessage(chatId, '❌ Название города не может быть пустым. Попробуйте еще раз:');
                    }
                    
                    if (data.streets[text]) {
                        session.city = text;
                        session.step = 'street';
                        return bot.sendMessage(chatId, `✅ Город: ${text}\n\n🏠 Введите название улицы:`);
                    }
                    
                    const results = fuseCities.search(text);
                    
                    if (results.length === 0) {
                        return bot.sendMessage(chatId, `❌ Город "${text}" не найден.\n\n💡 Проверьте правильность написания или выберите из списка:\nhttps://www.dtek-oem.com.ua/ua/shutdowns\n\nВведите другой город:`);
                    }
                    
                    if (results.length === 1) {
                        session.city = results[0].item;
                        session.step = 'street';
                        return bot.sendMessage(chatId, `✅ Город: ${results[0].item}\n\n🏠 Введите название улицы:`);
                    }
                    
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
                    
                    if (streets.includes(text)) {
                        session.street = text;
                        session.step = 'houseNumber';
                        const keyboard = {
                            inline_keyboard: [[{ text: '⏭ Пропустить (вся улица)', callback_data: 'skip_house' }]]
                        };
                        return bot.sendMessage(chatId, `✅ Улица: ${text}\n\n🏘 Введите номер дома или пропустите для всей улицы:`, { reply_markup: keyboard });
                    }
                    
                    const fuseStreets = new Fuse(streets, { threshold: 0.4 });
                    const streetResults = fuseStreets.search(text);
                    
                    if (streetResults.length === 0) {
                        return bot.sendMessage(chatId, `❌ Улица "${text}" не найдена в городе ${session.city}.\n\n💡 Проверьте правильность написания или выберите из списка:\nhttps://www.dtek-oem.com.ua/ua/shutdowns\n\nВведите другую улицу:`);
                    }
                    
                    if (streetResults.length === 1) {
                        session.street = streetResults[0].item;
                        session.step = 'houseNumber';
                        const keyboard = {
                            inline_keyboard: [[{ text: '⏭ Пропустить (вся улица)', callback_data: 'skip_house' }]]
                        };
                        return bot.sendMessage(chatId, `✅ Улица: ${streetResults[0].item}\n\n🏘 Введите номер дома или пропустите для всей улицы:`, { reply_markup: keyboard });
                    }
                    
                    const streetSuggestions = streetResults.slice(0, 5);
                    session.streetSuggestions = streetSuggestions;
                    const streetKeyboard = {
                        inline_keyboard: streetSuggestions.map((r, i) => [{ text: r.item, callback_data: `select_street_${i}` }])
                    };
                    return bot.sendMessage(chatId, '🔍 Найдено несколько вариантов. Выберите:', { reply_markup: streetKeyboard });
                    
                case 'houseNumber':
                    const houseNumber = text?.trim() || '';
                    // Save address without specifying mode (it will be determined automatically)
                    await db.saveAddress(chatId, session.city, session.street, houseNumber);
                    addressUpdatedTimestamps.set(String(chatId), Date.now());
                    dtekCheckTimestamps.set(String(chatId), Date.now());
                    // После обновления адреса синхронизируем режим
                    const afterAddr = await db.getLightState(chatId);
                    await updateModeIfNeeded(chatId, afterAddr?.mode, afterAddr);

                    const addressText = houseNumber 
                        ? `📍 Адрес сохранен:\n${session.city}, ${session.street}, ${houseNumber}`
                        : `📍 Адрес сохранен:\n${session.city}, ${session.street} (вся улица)`;
                    
                    // Get DTEK info without updating state (will be handled by the periodic check)
                    const dtekMsg = await getDtekInfo(chatId, false, false);
                    
                    // Send the address and DTEK info
                    await bot.sendMessage(chatId, `${addressText}\n\n📊 DTEK (текущий статус):\n${dtekMsg}`);
                    
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
        if (data.startsWith('city_')) {
            const city = data.replace('city_', '');
            if (cities.includes(city)) {
                userSessions[chatId] = { step: 'street', city: city };
                bot.sendMessage(chatId, `✅ Город: ${city}\n\n🏠 Введите название улицы:`);
            }
        }
        else if (data.startsWith('select_city_')) {
            const index = parseInt(data.replace('select_city_', ''));
            if (userSessions[chatId]?.citySuggestions?.[index]) {
                const city = userSessions[chatId].citySuggestions[index].item;
                userSessions[chatId] = { step: 'street', city: city };
                bot.sendMessage(chatId, `✅ Город: ${city}\n\n🏠 Введите название улицы:`);
            }
        }
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
        else if (data === 'skip_house') {
            if (userSessions[chatId]?.step === 'houseNumber') {
                const session = userSessions[chatId];
                // Save address without specifying mode (it will be determined automatically)
                await db.saveAddress(chatId, session.city, session.street, '');
                addressUpdatedTimestamps.set(String(chatId), Date.now());
                dtekCheckTimestamps.set(String(chatId), Date.now());
                const afterSkip = await db.getLightState(chatId);
                await updateModeIfNeeded(chatId, afterSkip?.mode, afterSkip);
                
                // Get DTEK info without updating state (will be handled by the periodic check)
                const dtekMsg = await getDtekInfo(chatId, false, false);
                
                // Send the address and DTEK info
                await bot.sendMessage(chatId, `📍 Адрес сохранен:\n${session.city}, ${session.street} (вся улица)\n\n📊 DTEK (текущий статус):\n${dtekMsg}`);
                
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