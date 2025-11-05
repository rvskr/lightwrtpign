const { google } = require('googleapis');
const { DateTime } = require('luxon');

// Unified cache
const cache = {};
const CACHE_TTL = 30000;

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

    cache(key, data) {
        if (data === undefined) {
            const cached = cache[key];
            return (cached && Date.now() - cached.t < CACHE_TTL) ? cached.d : null;
        }
        if (data === null) delete cache[key];
        else cache[key] = { d: data, t: Date.now() };
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
        const toBool = v => v === 'TRUE' || v === 'true' || v === true;
        return {
            chat_id: row[0],
            last_ping_time: row[1] || '',
            light_state: toBool(row[2]),
            light_start_time: row[3] || '',
            previous_duration: row[4] || '',
            pinned_message_id: row[5] || '',
            city: row[6] || '',
            street: row[7] || '',
            house_number: row[8] || '',
            ignored: toBool(row[9]),
            mode: row[10] || 'full',
            first_name: row[11] || '',
            last_name: row[12] || '',
            username: row[13] || '',
            user_link: row[14] || ''
        };
    }

    async saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
        try {
            this.cache(chatId, null);
            this.cache('all', null);
            const row = await this.findRowByChatId(chatId);
            const fmt = dt => `'${dt.toFormat('dd.MM.yyyy HH:mm:ss')}`;
            const values = [[
                fmt(lastPingTime),
                lightState ? 'TRUE' : 'FALSE',
                fmt(lightStartTime),
                previousDuration ? previousDuration.toFormat('hh:mm:ss') : ''
            ]];
            
            if (!row) {
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:I`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[chatId, ...values[0], '', '', '', '']] }
                });
            } else {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!B${row}:E${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                });
            }
            this.logger.info(`Данные для chat_id ${chatId} сохранены`);
        } catch (error) {
            this.logger.error(`Ошибка сохранения: ${error.message}`);
            throw error;
        }
    }

    async getLightState(chatId) {
        try {
            const cached = this.cache(chatId);
            if (cached !== null) return cached;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
            });

            const rows = response.data.values;
            const dataRow = rows?.slice(1).find(row => row[0] === String(chatId));
            const result = dataRow ? this.parseRow(dataRow) : null;
            this.cache(chatId, result);
            return result;
        } catch (error) {
            this.logger.error(`Ошибка получения состояния: ${error.message}`);
            return null;
        }
    }

    async getAllLightStates() {
        try {
            const cached = this.cache('all');
            if (cached !== null) return cached;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
            });

            const rows = response.data.values;
            const result = rows?.slice(1).map(row => this.parseRow(row)) || [];
            this.cache('all', result);
            return result;
        } catch (error) {
            this.logger.error(`Ошибка чтения всех данных: ${error.message}`);
            return [];
        }
    }

    async saveAddress(chatId, city, street, houseNumber, mode = 'full') {
        try {
            this.cache(chatId, null);
            this.cache('all', null);
            const row = await this.findRowByChatId(chatId);
            
            if (row) {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!G${row}:K${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[city, street, houseNumber, 'FALSE', mode]] }
                });
            } else {
                const now = DateTime.now();
                const fmt = `'${now.toFormat('dd.MM.yyyy HH:mm:ss')}`;
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:K`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[chatId, fmt, 'FALSE', fmt, '', '', city, street, houseNumber, 'FALSE', mode]] }
                });
            }
            this.logger.info(`Адрес для ${chatId} сохранен`);
        } catch (error) {
            this.logger.error(`Ошибка сохранения адреса: ${error.message}`);
        }
    }

    async initializeUser(chatId) {
        try {
            if (await this.findRowByChatId(chatId)) return true;

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:K`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[chatId, '', '', '', '', '', '', '', '', 'FALSE', '']] }
            });

            this.cache('all', null);
            this.logger.info(`Пользователь ${chatId} инициализирован`);
            return true;
        } catch (error) {
            this.logger.error(`Ошибка инициализации ${chatId}: ${error.message}`);
            return false;
        }
    }

    async updateField(chatId, column, value) {
        try {
            this.cache(chatId, null);
            this.cache('all', null);
            const row = await this.findRowByChatId(chatId);
            if (!row) return false;

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!${column}${row}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[value]] }
            });
            return true;
        } catch (error) {
            this.logger.error(`Ошибка обновления: ${error.message}`);
            return false;
        }
    }

    async setIgnored(chatId, ignored) {
        return this.updateField(chatId, 'J', ignored ? 'TRUE' : 'FALSE');
    }

    async saveUserInfo(chatId, userInfo) {
        try {
            this.cache(chatId, null);
            this.cache('all', null);
            const row = await this.findRowByChatId(chatId);
            if (!row) return false;

            const { first_name = '', last_name = '', username = '' } = userInfo;
            const user_link = username ? `https://t.me/${username}` : '';

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!L${row}:O${row}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[first_name, last_name, username, user_link]] }
            });
            
            this.logger.info(`Информация о пользователе ${chatId} сохранена`);
            return true;
        } catch (error) {
            this.logger.error(`Ошибка сохранения информации о пользователе: ${error.message}`);
            return false;
        }
    }

    async getIgnored(chatId) {
        return (await this.getLightState(chatId))?.ignored || false;
    }

    async savePinnedMessageId(chatId, messageId) {
        return this.updateField(chatId, 'F', messageId);
    }

    async setMode(chatId, mode) {
        return this.updateField(chatId, 'K', mode);
    }

    async getMode(chatId) {
        return (await this.getLightState(chatId))?.mode || null;
    }
}

module.exports = SheetsDB;