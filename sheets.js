const { google } = require('googleapis');
const { DateTime } = require('luxon');

// Cache
const lightStateCache = {};
const CACHE_TTL_MS = 30000;
const allStatesCache = {};
const ALL_STATES_CACHE_TTL_MS = 30000;

class SheetsDB {
    constructor(logger) {
        this.logger = logger;
        this.sheets = null;
        this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
        this.sheetName = 'LightStates';
    }

    async initialize() {
        try {
            const credentialsStr = process.env.GOOGLE_CREDENTIALS;
            const credentials = typeof credentialsStr === 'string' ? JSON.parse(credentialsStr) : credentialsStr;
            
            const auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            this.sheets = google.sheets({ version: 'v4', auth });
            this.logger.info('Google Sheets API инициализирован');
            await this.ensureSheetExists();
        } catch (error) {
            this.logger.error(`Ошибка инициализации Google Sheets: ${error.message}`);
            throw error;
        }
    }

    async ensureSheetExists() {
        try {
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId: this.spreadsheetId,
            });

            const sheetExists = response.data.sheets.some(
                sheet => sheet.properties.title === this.sheetName
            );

            if (!sheetExists) {
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.spreadsheetId,
                    resource: {
                        requests: [{
                            addSheet: {
                                properties: { title: this.sheetName }
                            }
                        }]
                    }
                });

                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A1:K1`,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [['chat_id', 'last_ping_time', 'light_state', 'light_start_time', 'previous_duration', 'pinned_message_id', 'city', 'street', 'house_number', 'ignored', 'mode']]
                    }
                });

                this.logger.info(`Лист ${this.sheetName} создан с заголовками`);
            }
        } catch (error) {
            this.logger.error(`Ошибка проверки/создания листа: ${error.message}`);
            throw error;
        }
    }

    clearAllCache() {
        delete allStatesCache['all'];
    }

    clearCache(chatId) {
        delete lightStateCache[chatId];
    }

    getCached(chatId) {
        const cached = lightStateCache[chatId];
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
            return cached.data;
        }
        return null;
    }

    setCache(chatId, data) {
        lightStateCache[chatId] = {
            data: data,
            timestamp: Date.now()
        };
    }

    getAllCached() {
        const cached = allStatesCache['all'];
        if (cached && (Date.now() - cached.timestamp) < ALL_STATES_CACHE_TTL_MS) {
            return cached.data;
        }
        return null;
    }

    setAllCache(data) {
        allStatesCache['all'] = {
            data: data,
            timestamp: Date.now()
        };
    }

    async findRowByChatId(chatId) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:A`,
            });

            const rows = response.data.values;
            if (!rows) return null;

            const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === String(chatId));
            return rowIndex >= 0 ? rowIndex + 1 : null;
        } catch (error) {
            this.logger.error(`Ошибка поиска строки: ${error.message}`);
            return null;
        }
    }

    parseRow(row) {
        return {
            chat_id: row[0],
            last_ping_time: row[1] || '',
            light_state: row[2] && (row[2] === 'TRUE' || row[2] === 'true' || row[2] === true),
            light_start_time: row[3] || '',
            previous_duration: row[4] || '',
            pinned_message_id: row[5] || '',
            city: row[6] || '',
            street: row[7] || '',
            house_number: row[8] || '',
            ignored: row[9] && (row[9] === 'TRUE' || row[9] === 'true' || row[9] === true),
            mode: row[10] || 'full'
        };
    }

    async saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
        try {
            this.clearCache(chatId);
            this.clearAllCache();
            const row = await this.findRowByChatId(chatId);
            
            if (!row) {
                const values = [[
                    chatId,
                    `'${lastPingTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    lightState ? 'TRUE' : 'FALSE',
                    `'${lightStartTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    previousDuration ? previousDuration.toFormat('hh:mm:ss') : '',
                    '', '', '', ''
                ]];
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:I`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                });
            } else {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!B${row}:E${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[
                        `'${lastPingTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                        lightState ? 'TRUE' : 'FALSE',
                        `'${lightStartTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                        previousDuration ? previousDuration.toFormat('hh:mm:ss') : ''
                    ]] }
                });
            }

            this.logger.info(`Данные для chat_id ${chatId} сохранены в Google Sheets`);
        } catch (error) {
            this.logger.error(`Ошибка сохранения в Google Sheets: ${error.message}`);
            throw error;
        }
    }

    async getLightState(chatId) {
        try {
            const cached = this.getCached(chatId);
            if (cached !== null) return cached;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                this.setCache(chatId, null);
                return null;
            }

            const dataRow = rows.slice(1).find(row => row[0] === String(chatId));
            if (!dataRow) {
                this.setCache(chatId, null);
                return null;
            }

            const result = this.parseRow(dataRow);
            this.setCache(chatId, result);
            return result;
        } catch (error) {
            this.logger.error(`Ошибка получения состояния света: ${error.message}`);
            return null;
        }
    }

    async getAllLightStates() {
        try {
            const cached = this.getAllCached();
            if (cached !== null) return cached;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                this.setAllCache([]);
                return [];
            }

            const result = rows.slice(1).map(row => this.parseRow(row));
            this.setAllCache(result);
            return result;
        } catch (error) {
            this.logger.error(`Ошибка чтения всех данных из Google Sheets: ${error.message}`);
            return [];
        }
    }

    async saveAddress(chatId, city, street, houseNumber, mode = 'full') {
        try {
            this.clearCache(chatId);
            this.clearAllCache();
            const row = await this.findRowByChatId(chatId);
            
            if (row) {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!G${row}:K${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[city, street, houseNumber, 'FALSE', mode]] }
                });
                this.logger.info(`Адрес для chat_id ${chatId} сохранен`);
            } else {
                const now = DateTime.now();
                const values = [[
                    chatId,
                    `'${now.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    'FALSE',
                    `'${now.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    '', '', city, street, houseNumber, 'FALSE', mode
                ]];
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:K`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                });
                this.logger.info(`Новая строка с адресом для chat_id ${chatId} создана`);
            }
        } catch (error) {
            this.logger.error(`Ошибка сохранения адреса: ${error.message}`);
        }
    }

    async initializeUser(chatId) {
        try {
            const existingRow = await this.findRowByChatId(chatId);
            if (existingRow) return true;

            const values = [[
                chatId, '', '', '', '', '', '', '', '', 'FALSE', ''
            ]];

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });

            this.clearAllCache();
            this.logger.info(`Пользователь ${chatId} инициализирован в таблице`);
            return true;
        } catch (error) {
            this.logger.error(`Ошибка инициализации пользователя ${chatId}: ${error.message}`);
            return false;
        }
    }

    async updateField(chatId, column, value) {
        try {
            this.clearCache(chatId);
            this.clearAllCache();
            const row = await this.findRowByChatId(chatId);
            if (!row) {
                this.logger.error(`Пользователь ${chatId} не найден для обновления поля`);
                return false;
            }

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!${column}${row}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[value]] }
            });

            return true;
        } catch (error) {
            this.logger.error(`Ошибка обновления поля: ${error.message}`);
            return false;
        }
    }

    async setIgnored(chatId, ignored) {
        const result = await this.updateField(chatId, 'J', ignored ? 'TRUE' : 'FALSE');
        if (result) this.logger.info(`Статус ignored для chat_id ${chatId} установлен в ${ignored}`);
        return result;
    }

    async getIgnored(chatId) {
        const row = await this.getLightState(chatId);
        return row?.ignored || false;
    }

    async savePinnedMessageId(chatId, messageId) {
        const result = await this.updateField(chatId, 'F', messageId);
        if (result) this.logger.info(`Pinned message ID ${messageId} сохранен для chat_id ${chatId}`);
        return result;
    }

    async setMode(chatId, mode) {
        const result = await this.updateField(chatId, 'K', mode);
        if (result) this.logger.info(`Режим ${mode} установлен для chat_id ${chatId}`);
        return result;
    }

    async getMode(chatId) {
        const row = await this.getLightState(chatId);
        return row?.mode || null;
    }
}

module.exports = SheetsDB;