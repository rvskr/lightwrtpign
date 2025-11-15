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

// ============================================
// УТИЛИТЫ И ХЕЛПЕРЫ
// ============================================

class Utils {
    static parseNum(s) {
        const m = String(s ?? '').match(/\d+/);
        return m ? parseInt(m[0], 10) : NaN;
    }

    static parseDateTime(timeString) {
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

    static canonicalizeStreet(city, street) {
        try {
            const knownStreets = Array.isArray(data?.streets?.[city]) ? data.streets[city] : null;
            if (knownStreets && !knownStreets.includes(street)) {
                const fuseStreets = new Fuse(knownStreets, { threshold: 0.3 });
                const r = fuseStreets.search(street);
                if (r && r.length > 0) {
                    logger.info('DTEK: canonicalized street', { city, inputStreet: street, streetToUse: r[0].item });
                    return r[0].item;
                }
            }
        } catch {}
        return street;
    }

    static hasDeviceConnected(row, { strict = false } = {}) {
        const hasTimes = row?.last_ping_time?.trim() && row?.light_start_time?.trim();
        if (!hasTimes) return false;
        if (!strict) return true;
        return row.last_ping_time !== row.light_start_time;
    }

    static formatStatusMessage(row, detailed = false) {
        const lightStartTime = Utils.parseDateTime(row.light_start_time);
        const currentDuration = DateTime.now().diff(lightStartTime);
        const icon = row.light_state ? '💡' : '🌑';
        const state = row.light_state ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН';
        const durationFormat = detailed ? 'hh:mm:ss' : 'd\'д\' h\'ч\' m\'мин\' s\'с\'';
        const duration = currentDuration.toFormat(durationFormat);

        if (detailed) {
            const prevDuration = row.previous_duration || 'неизвестно';
            return `${icon} Свет ${state}\n⏱ Текущий статус: ${duration}\n📊 Предыдущий статус: ${prevDuration}`;
        }
        
        return `${icon} Свет ${state}\n⏱${duration}`;
    }

    static getAddressSavedMessage(city, street, house) {
        return `Адрес сохранен: ${city}, ${street}, ${house}\n\n⚡ Для информации об отключениях используйте /dtek\n🔌 Для автоматического мониторинга подключите устройство для отправки пингов`;
    }
}

// Middleware
class Middleware {
    static checkRateLimit(chatId) {
        const now = Date.now();
        const lastRequest = userRateLimits[chatId];
        if (lastRequest && (now - lastRequest) < RATE_LIMIT_MS) return false;
        userRateLimits[chatId] = now;
        return true;
    }

    static async shouldSkipChat(chatId) {
        const row = await db.getLightState(chatId);
        return row?.ignored || false;
    }

    static withRateLimit(handler) {
        return async (msg) => {
            const chatId = msg.chat.id;
            if (!Middleware.checkRateLimit(chatId)) return;
            return handler(msg);
        };
    }

    static withSkipCheck(handler) {
        return async (msg) => {
            const chatId = msg.chat.id;
            if (await Middleware.shouldSkipChat(chatId)) return;
            return handler(msg);
        };
    }

    static withBoth(handler) {
        return Middleware.withRateLimit(Middleware.withSkipCheck(handler));
    }
}

// ============================================
// СЕРВИСЫ
// ============================================

// Сервис управления адресами и сессиями


class AddressService {
    static async saveAndNotify(chatId, session) {
        // Получаем данные из парсера для определения очереди
        let queue = '';
        try {
            const streetToUse = Utils.canonicalizeStreet(session.city, session.street);
            const result = await fetchData(session.city, streetToUse, session.houseNumber);
            if (result?.data) {
                const keys = Object.keys(result.data);
                const houseKey = keys.find(k => k === session.houseNumber) || 
                                keys.find(k => k.toLowerCase() === session.houseNumber.toLowerCase()) ||
                                keys[0];
                
                if (houseKey && result.data[houseKey]?.sub_type_reason) {
                    const reasons = result.data[houseKey].sub_type_reason;
                    queue = Array.isArray(reasons) ? reasons[0] || '' : String(reasons || '');
                    logger.info(`Определена очередь ${queue} для адреса ${session.city}, ${session.street}, ${session.houseNumber}`);
                }
            }
        } catch (e) {
            logger.error(`Ошибка определения очереди для ${chatId}: ${e.message}`);
        }
        
        await db.saveAddress(chatId, session.city, session.street, session.houseNumber, queue);
        bot.sendMessage(chatId, Utils.getAddressSavedMessage(session.city, session.street, session.houseNumber));
        NotificationService.updatePinnedMessage(chatId);
        delete userSessions[chatId];
    }

    static buildHouseKeyboard(session, page = 0) {
        const pageSize = 9;
        const keys = session.housesKeys || [];
        const total = keys.length;
        const start = Math.max(0, page * pageSize);
        const slice = keys.slice(start, start + pageSize);
        const rows = [];
        for (let i = 0; i < slice.length; i += 3) {
            const row = slice.slice(i, i + 3).map((k) => {
                return { text: k, callback_data: `select_house_val_${encodeURIComponent(k)}` };
            });
            rows.push(row);
        }
        const navRow = [];
        if (start > 0) navRow.push({ text: '⬅️ Назад', callback_data: `houses_page_${page - 1}` });
        if (start + pageSize < total) navRow.push({ text: '➡️ Далее', callback_data: `houses_page_${page + 1}` });
        if (navRow.length) rows.push(navRow);
        
        // Добавляем кнопку для ручного ввода на последней странице
        if (start + pageSize >= total) {
            rows.push([{ text: '✏️ Ввести номер вручную', callback_data: 'manual_house_input' }]);
        }
        
        return { inline_keyboard: rows };
    }

    static async handleHouseNumberInput(chatId, session, input) {
        try {
            // Если пользователь явно выбрал ручной ввод, сохраняем сразу
            if (session.manualInput) {
                session.houseNumber = input;
                delete session.manualInput; // Очищаем флаг
                return await AddressService.saveAndNotify(chatId, session);
            }
            
            const result = await fetchData(session.city, session.street, input);
            const keys = Object.keys(result?.data || {});
            
            if (keys.length === 0) {
                session.houseNumber = input;
                return await AddressService.saveAndNotify(chatId, session);
            }

            const exact = keys.find(k => k === input) || keys.find(k => k.toLowerCase() === input.toLowerCase());
            if (exact) {
                session.houseNumber = exact;
                return await AddressService.saveAndNotify(chatId, session);
            }

            const normIn = input.toLowerCase().replace(/\s+/g, '');
            const inNum = Utils.parseNum(input);

            let candidates = keys.filter(k => {
                const nk = k.toLowerCase().replace(/\s+/g, '');
                if (nk.startsWith(normIn) || nk.includes(normIn)) return true;
                if (!Number.isNaN(inNum)) {
                    const kn = Utils.parseNum(k);
                    if (!Number.isNaN(kn) && Math.abs(kn - inNum) <= 2) return true;
                }
                return false;
            });

            if (candidates.length === 1) {
                session.houseNumber = candidates[0];
                return await AddressService.saveAndNotify(chatId, session);
            }

            if (candidates.length === 0) {
                // Если совпадений нет, предлагаем использовать введенный номер или показываем ближайшие
                if (!Number.isNaN(inNum)) {
                    candidates = keys
                        .map(k => ({ k, n: Utils.parseNum(k) }))
                        .filter(x => !Number.isNaN(x.n))
                        .sort((a,b) => Math.abs(a.n - inNum) - Math.abs(b.n - inNum))
                        .slice(0, 10)
                        .map(x => x.k);
                } else {
                    candidates = keys.slice(0, 10);
                }
                
                // Если всё равно нет кандидатов, сохраняем введенный номер
                if (candidates.length === 0) {
                    session.houseNumber = input;
                    return await AddressService.saveAndNotify(chatId, session);
                }
            }

            session.houseSuggestions = candidates.slice(0, 10).map(item => ({ item }));
            const keyboard = {
                inline_keyboard: session.houseSuggestions.map((r, i) => [{ text: r.item, callback_data: `select_house_val_${encodeURIComponent(r.item)}` }])
            };
            bot.sendMessage(chatId, 'Выберите номер дома из найденных вариантов:', { reply_markup: keyboard });
        } catch (e) {
            logger.error(`Ошибка подбора номера дома для ${chatId}: ${e.message}`);
            bot.sendMessage(chatId, 'Не удалось получить варианты номеров дома. Введите точный номер дома, например: 63/1, 41А.');
        }
    }

    static async showHouseOptions(chatId) {
        const session = userSessions[chatId];
        if (!session?.city || !session?.street) return;
        try {
            session.street = Utils.canonicalizeStreet(session.city, session.street);
            const result = await fetchData(session.city, session.street, '');
            let keys = Object.keys(result?.data || {});
            try { keys = keys.sort((a, b) => a.localeCompare(b, 'uk', { numeric: true, sensitivity: 'base' })); } catch {}
            session.housesKeys = keys;
            session.housesPage = 0;
            const keyboard = AddressService.buildHouseKeyboard(session, 0);
            
            const message = keys.length > 0 
                ? 'Выберите номер дома из списка или введите вручную:'
                : 'Список домов пуст. Введите номер дома вручную:';
            
            await bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } catch (e) {
            logger.error(`Ошибка загрузки списка домов для ${chatId}: ${e.message}`);
            bot.sendMessage(chatId, 'Не удалось получить список домов. Введите точный номер дома.');
            session.step = 'houseNumber';
        }
    }
}

// DTEK сервис
class DtekService {
    static async fetchAndSummarize(city, street, house_number, queue = null) {
        try {
            const streetToUse = Utils.canonicalizeStreet(city, street);
            const result = await fetchData(city, streetToUse, house_number);
            if (!result) {
                return { inferredOff: false, message: `Не удалось получить данные для ${city}, ${streetToUse}, ${house_number}.` };
            }

            const { data, updateTimestamp, resolvedHomeKey, showCurOutageParam } = result;
            const keys = Object.keys(data || {});
            const inputNum = Utils.parseNum(house_number);
        let keyToUse = null;
        if (resolvedHomeKey && data?.[resolvedHomeKey]) {
            keyToUse = resolvedHomeKey;
        } else if (data?.[house_number]) {
            keyToUse = house_number;
        }
            if (!keyToUse && keys.length > 0) {
                let bestKey = keys[0];
                if (!Number.isNaN(inputNum)) {
                    let bestDiff = Infinity;
                    for (const k of keys) {
                        const kn = Utils.parseNum(k);
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
            
            // Если нет данных по конкретному дому, пробуем найти по очереди
            if (!houseData.sub_type && !showCurOutageParam) {
                // Если есть очередь, ищем другие адреса с такой же очередью
                if (queue && queue.trim()) {
                    try {
                        const addressesByQueue = await db.getAddressesByQueue(queue);
                        logger.info(`Поиск по очереди ${queue}: найдено ${addressesByQueue.length} адресов`);
                        
                        // Пробуем получить данные по другим адресам с той же очередью
                        for (const addr of addressesByQueue) {
                            if (addr.city === city && addr.street === street && addr.house_number === house_number) {
                                continue; // Пропускаем текущий адрес
                            }
                            
                            const queueResult = await fetchData(addr.city, addr.street, addr.house_number);
                            if (queueResult?.data) {
                                const queueKeys = Object.keys(queueResult.data);
                                for (const qk of queueKeys) {
                                    const qData = queueResult.data[qk];
                                    if (qData?.sub_type || qData?.start_date || qData?.end_date) {
                                        logger.info(`Найдены данные по очереди ${queue} для адреса ${addr.city}, ${addr.street}, ${addr.house_number}`);
                                        return {
                                            inferredOff: true,
                                            message: `Обновлено: ${queueResult.updateTimestamp || updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nОчередь: ${queue}\n(Данные по аналогичному адресу: ${addr.city}, ${addr.street}, ${addr.house_number})\n\nТип: ${qData.sub_type || 'Не указано'}\nНачало: ${qData.start_date || 'Не указано'}\nОкончание: ${qData.end_date || 'Не указано'}\nТип причины: ${qData.sub_type_reason?.join(', ') || 'Не указано'}`,
                                            updateTimestamp: queueResult.updateTimestamp || updateTimestamp
                                        };
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        logger.error(`Ошибка поиска по очереди ${queue}: ${e.message}`);
                    }
                }
                
                return { inferredOff: false, message: `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}` };
            }

            if (!houseData.sub_type && showCurOutageParam) {
                const all = Object.values(data || {});
                const isActive = (x) => !!(x && (x.sub_type?.trim() || x.start_date?.trim() || x.end_date?.trim()));
                const activeCandidates = all.filter(isActive);
                
                // Если нет ни одного дома с реальными данными об отключениях, значит отключений нет
                if (activeCandidates.length === 0) {
                    return { inferredOff: false, message: `По адресу ${city}, ${street}, ${house_number} отключений нет. Обновлено: ${updateTimestamp}` };
                }

                const reasons = [...new Set(activeCandidates.flatMap(x => Array.isArray(x?.sub_type_reason) ? x.sub_type_reason : []).filter(Boolean))];
                const parseMaybe = (s) => {
                    if (!s || !s.trim()) return null;
                    const dt = DateTime.fromFormat(s.trim(), 'HH:mm dd.MM.yyyy');
                    return dt.isValid ? dt : null;
                };
                const starts = activeCandidates.map(x => parseMaybe(x?.start_date)).filter(Boolean);
                const ends = activeCandidates.map(x => parseMaybe(x?.end_date)).filter(Boolean);
                const minStart = starts.length ? starts.reduce((a,b) => a < b ? a : b) : null;
                const maxEnd = ends.length ? ends.reduce((a,b) => a > b ? a : b) : null;
                const startText = minStart ? minStart.toFormat('HH:mm dd.MM.yyyy') : 'Не указано';
                const endText = maxEnd ? maxEnd.toFormat('HH:mm dd.MM.yyyy') : 'Не указано';

                return {
                    inferredOff: false,
                    message: `Обновлено: ${updateTimestamp}\n\nАдрес: ${city}, ${street}, ${house_number}\nСтатус: По вашему адресу отключение не указано. На улице зафиксированы отключения/ограничения.\nПричины: ${reasons.length ? reasons.join(', ') : 'Не указано'}\nНачало: ${startText}\nОкончание: ${endText}`,
                    updateTimestamp
                };
            }

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

    static async getInfo(chatId) {
        const row = await db.getLightState(chatId);
        if (!row?.city || !row?.street || !row?.house_number) {
            return 'Адрес не настроен. Используйте /address для настройки.';
        }

        const { city, street, house_number, queue } = row;
        const summary = await DtekService.fetchAndSummarize(city, street, house_number, queue);
        return summary.message;
    }
}

// Сервис уведомлений
class NotificationService {
    static async updatePinnedMessage(chatId, row = null, message = null) {
        if (await Middleware.shouldSkipChat(chatId)) return;
        
        try {
            const dataRow = row || await db.getLightState(chatId);
            if (!dataRow) return;
            
            const messageToSend = message || Utils.formatStatusMessage(dataRow);
            const pinnedMessageId = dataRow.pinned_message_id;
            
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

    static async notifyStatusChange(chatId, statusMessage, row) {
        if (await Middleware.shouldSkipChat(chatId)) return;
        await NotificationService.updatePinnedMessage(chatId, row);
        await bot.sendMessage(chatId, statusMessage)
            .then(() => logger.info('Сообщение отправлено'))
            .catch((error) => logger.error(`Ошибка отправки сообщения: ${error}`));
    }
}

// Сервис состояния света
class LightStateService {
    static async updatePingTime(chatId) {
        if (await Middleware.shouldSkipChat(chatId)) return;
        
        const now = DateTime.now();
        logger.info(`Получен пинг от ${chatId}`);
        let row = await db.getLightState(chatId);
        
        if (!row) {
            await db.saveLightState(chatId, now, true, now, null);
            row = await db.getLightState(chatId);
            NotificationService.updatePinnedMessage(chatId, row);
            return bot.sendMessage(chatId, '💡 Свет ВКЛЮЧЕН');
        }
        
        if (!row.light_state) {
            const offDuration = now.diff(Utils.parseDateTime(row.light_start_time));
            await db.saveLightState(chatId, now, true, now, null);
            row = await db.getLightState(chatId);
            await NotificationService.notifyStatusChange(chatId, `💡 Свет ВКЛЮЧЕН\n⏸ Был выключен: ${offDuration.toFormat('hh:mm:ss')}`, row);
            logger.info(`Свет включен для ${chatId} (был выключен ${offDuration.toFormat('hh:mm:ss')})`);
        } else {
            await db.saveLightState(chatId, now, true, Utils.parseDateTime(row.light_start_time), null);
            NotificationService.updatePinnedMessage(chatId, row);
            logger.info(`Свет включен, обновлен last_ping_time для ${chatId}`);
        }
    }

    static async checkLightsStatus() {
        try {
            const now = DateTime.now();
            const rows = await db.getAllLightStates();
            
            for (const row of rows) {
                if (row.ignored) continue;
                
                const deviceConnected = Utils.hasDeviceConnected(row);
                if (!deviceConnected) continue;
                
                const lastPingTime = Utils.parseDateTime(row.last_ping_time);
                const timeSinceLastPing = now.diff(lastPingTime).as('seconds');
                
                if (timeSinceLastPing > PING_TIMEOUT_SEC && row.light_state) {
                    const lightStartTime = Utils.parseDateTime(row.light_start_time);
                    const onDuration = now.diff(lightStartTime);
                    await db.saveLightState(row.chat_id, now, false, now, onDuration);
                    const newRow = await db.getLightState(row.chat_id);
                    await NotificationService.notifyStatusChange(row.chat_id, `🌑 Свет ВЫКЛЮЧЕН\n⏸ Был включен: ${onDuration.toFormat('hh:mm:ss')}`, newRow);
                    logger.info(`Свет выключен для ${row.chat_id} (нет пинга ${Math.round(timeSinceLastPing)}s)`);
                    
                    const dtekMessage = await DtekService.getInfo(row.chat_id);
                    await bot.sendMessage(row.chat_id, dtekMessage)
                        .catch((error) => logger.error(`Ошибка отправки DTEK: ${error}`));
                } else if (deviceConnected) {
                    await NotificationService.updatePinnedMessage(row.chat_id);
                    logger.info(`Мастер-сообщение обновлено для ${row.chat_id} (${row.light_state ? 'включен' : 'выключен'})`);
                }
            }
        } catch (error) {
            logger.error(`Ошибка проверки: ${error.message}`);
        }
    }
}

// --- Маршруты Express ---

app.get('/check-lights', async (req, res) => {
    await LightStateService.checkLightsStatus();
    res.json({ status: 'ok', message: 'Проверка выполнена' });
});

const handlePing = async (req, res) => {
    const chatId = req.body?.chat_id || req.query?.c || req.query?.chat_id;
    if (chatId && !(await Middleware.shouldSkipChat(chatId))) {
        LightStateService.updatePingTime(chatId);
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

// --- Команды бота ---

bot.onText(/\/start(?:@\w+)?/, async (msg) => {
    const startTime = Date.now();
    const chatId = msg.chat.id;
    if (!Middleware.checkRateLimit(chatId)) return;
    
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
    if (!Middleware.checkRateLimit(chatId)) return;
    
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
    if (!Middleware.checkRateLimit(chatId) || await Middleware.shouldSkipChat(chatId)) return;
    
    const row = await db.getLightState(chatId);
    if (!row) {
        return bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте /start для переинициализации.');
    }
    
    const hasAddress = row.city?.trim();
    
    if (!hasAddress) {
        return bot.sendMessage(chatId, '📍 Адрес не настроен\n\n💡 Для получения информации об отключениях используйте /address для настройки адреса\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов');
    }
    
    const deviceConnectedStrict = Utils.hasDeviceConnected(row, { strict: true });
    if (!deviceConnectedStrict) {
        return bot.sendMessage(chatId, `📍 Адрес настроен для мониторинга\n🏠 ${row.city}, ${row.street}, ${row.house_number}\n\n💡 Можете использовать /dtek для получения информации об отключениях\n🔌 Для автоматического отслеживания подключите устройство для отправки пингов`);
    }
    
    bot.sendMessage(chatId, Utils.formatStatusMessage(row, true));
    logger.info(`Статус отправлен для ${chatId} (время: ${Date.now() - startTime} ms)`);
});

bot.onText(/\/address(?:@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!Middleware.checkRateLimit(chatId) || await Middleware.shouldSkipChat(chatId)) return;
    
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
    if (await Middleware.shouldSkipChat(chatId) || !Middleware.checkRateLimit(chatId)) return;
    
    const message = await DtekService.getInfo(chatId);
    bot.sendMessage(chatId, message);
    logger.info(`DTEK информация отправлена для ${chatId} (время: ${Date.now() - startTime} ms)`);
});

// Обработка сообщений для сессий
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    
    if (await Middleware.shouldSkipChat(chatId)) return;
    if (text && /^\/(start|stop|status|address|dtek)(?:@\w+)?/.test(text)) return;
    
    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        
        try {
            switch (session.step) {
                case 'city':
                    if (!text) {
                        return bot.sendMessage(chatId, 'Ошибка: название города не может быть пустым.');
                    }
                    
                    let cityToUse = text;
                    if (!data.streets[text]) {
                        const results = fuseCities.search(text);
                        if (results.length > 0) {
                            cityToUse = results[0].item;
                            if (results.length > 1 && !data.streets[text]) {
                                const suggestions = results.slice(0, 5);
                                session.citySuggestions = suggestions;
                                const keyboard = {
                                    inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_city_${i}` }])
                                };
                                return bot.sendMessage(chatId, 'Город не найден. Выберите вариант:', { reply_markup: keyboard });
                            }
                        } else {
                            return bot.sendMessage(chatId, 'Город не найден. Введите точное название города из списка DTEK.');
                        }
                    }
                    
                    session.city = cityToUse;
                    session.step = 'street';
                    bot.sendMessage(chatId, `Город выбран: ${session.city}\nВведите название улицы.`);
                    break;
                    
                case 'street':
                    if (!text) {
                        return bot.sendMessage(chatId, 'Ошибка: название улицы не может быть пустым.');
                    }
                    
                    let streetToUse = text;
                    if (data.streets[session.city] && !data.streets[session.city].includes(text)) {
                        const fuseStreets = new Fuse(data.streets[session.city], { threshold: 0.4 });
                        const results = fuseStreets.search(text);
                        
                        if (results.length > 0) {
                            streetToUse = results[0].item;
                            if (results.length > 1 && !data.streets[session.city].includes(text)) {
                                const suggestions = results.slice(0, 5);
                                session.streetSuggestions = suggestions;
                                const keyboard = {
                                    inline_keyboard: suggestions.map((r, i) => [{ text: r.item, callback_data: `select_street_${i}` }])
                                };
                                return bot.sendMessage(chatId, 'Улица не найдена. Выберите вариант:', { reply_markup: keyboard });
                            }
                        } else {
                            return bot.sendMessage(chatId, 'Улица не найдена. Введите точное название улицы из списка DTEK.');
                        }
                    }
                    
                    session.street = streetToUse;
                    session.step = 'houseNumber';
                    await AddressService.showHouseOptions(chatId);
                    break;
                    
                case 'houseNumber':
                    if (!text) {
                        return bot.sendMessage(chatId, 'Ошибка: номер дома не может быть пустым.');
                    }
                    await AddressService.handleHouseNumberInput(chatId, session, text);
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
    const session = userSessions[chatId];
    
    if (await Middleware.shouldSkipChat(chatId)) return;
    
    if (data.startsWith('select_city_')) {
        const index = parseInt(data.replace('select_city_', ''));
        if (session?.citySuggestions?.[index]) {
            const city = session.citySuggestions[index].item;
            userSessions[chatId] = { step: 'street', city: city };
            bot.sendMessage(chatId, `Город выбран: ${city}\nВведите название улицы.`);
        }
    } else if (data.startsWith('select_street_')) {
        const index = parseInt(data.replace('select_street_', ''));
        if (session?.streetSuggestions?.[index]) {
            const street = session.streetSuggestions[index].item;
            session.street = street;
            session.step = 'houseNumber';
            await AddressService.showHouseOptions(chatId);
        }
    } else if (data === 'manual_house_input') {
        if (session) {
            session.step = 'houseNumber';
            session.manualInput = true; // Флаг что пользователь выбрал ручной ввод
            bot.sendMessage(chatId, 'Введите номер дома (например: 38, 41А, 63/1):');
        }
    } else if (data.startsWith('houses_page_')) {
        const page = parseInt(data.replace('houses_page_', ''));
        if (session?.housesKeys && !Number.isNaN(page)) {
            session.housesPage = Math.max(0, page);
            const keyboard = AddressService.buildHouseKeyboard(session, session.housesPage);
            try {
                await bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: query.message.message_id });
            } catch (e) {
                // fallback: send new message
                await bot.sendMessage(chatId, 'Выберите номер дома:', { reply_markup: keyboard });
            }
        }
    } else if (data.startsWith('select_house_val_') || data.startsWith('select_house_')) {
        if (!session) return;
        
        let house = null;
        if (data.startsWith('select_house_val_')) {
            const valEnc = data.substring('select_house_val_'.length);
            house = decodeURIComponent(valEnc);
        } else {
            const index = parseInt(data.replace('select_house_', ''));
            if (session.housesKeys && !Number.isNaN(index) && session.housesKeys[index]) {
                house = session.housesKeys[index];
            } else if (session.houseSuggestions?.[index]) {
                house = session.houseSuggestions[index].item;
            }
        }
        
        if (house) {
            session.houseNumber = house;
            try {
                await AddressService.saveAndNotify(chatId, session);
            } catch (e) {
                logger.error(`Ошибка сохранения адреса после выбора дома для ${chatId}: ${e.message}`);
                bot.sendMessage(chatId, 'Не удалось сохранить адрес. Попробуйте снова.');
            }
        }
    }
    bot.answerCallbackQuery(query.id);
});

// --- Запуск сервера ---

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
        
        setInterval(LightStateService.checkLightsStatus, LIGHTS_CHECK_INTERVAL_MS);
        logger.info('Проверка состояния по пингам запущена (каждые 60 секунд)');
        
        setTimeout(() => {
            logger.info('🔄 Выполняем первоначальную проверку состояния...');
            LightStateService.checkLightsStatus();
        }, 2000);
    } catch (error) {
        logger.error(`Ошибка инициализации: ${error.message}`);
        process.exit(1);
    }
})();