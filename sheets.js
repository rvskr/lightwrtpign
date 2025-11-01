const { google } = require('googleapis');
const { DateTime } = require('luxon');

class SheetsDB {
    constructor(logger) {
        this.logger = logger;
        this.sheets = null;
        this.spreadsheetId = process.env.GOOGLE_SHEET_ID;
        this.sheetName = 'LightStates';
    }

    async initialize() {
        try {
            // Создаем клиента из JSON credentials
            // Обрабатываем случай когда JSON может быть многострочным
            let credentialsStr = process.env.GOOGLE_CREDENTIALS;
            
            // Если это не JSON объект, а строка - парсим
            const credentials = typeof credentialsStr === 'string' 
                ? JSON.parse(credentialsStr) 
                : credentialsStr;
            
            const auth = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            this.sheets = google.sheets({ version: 'v4', auth });
            this.logger.info('Google Sheets API инициализирован');

            // Проверяем существование листа, если нет - создаем
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
                // Создаем новый лист
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.spreadsheetId,
                    resource: {
                        requests: [{
                            addSheet: {
                                properties: {
                                    title: this.sheetName,
                                }
                            }
                        }]
                    }
                });

                // Добавляем заголовки
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A1:I1`,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [['chat_id', 'last_ping_time', 'light_state', 'light_start_time', 'previous_duration', 'pinned_message_id', 'city', 'street', 'house_number']]
                    }
                });

                this.logger.info(`Лист ${this.sheetName} создан с заголовками`);
            }
        } catch (error) {
            this.logger.error(`Ошибка проверки/создания листа: ${error.message}`);
            throw error;
        }
    }

    async saveLightState(chatId, lastPingTime, lightState, lightStartTime, previousDuration) {
        try {
            const row = await this.findRowByChatId(chatId);
            // Читаем текущее значение pinned_message_id и адреса
            const currentRow = await this.getLightState(chatId);
            const pinnedMessageId = currentRow?.pinned_message_id || '';
            const city = currentRow?.city || '';
            const street = currentRow?.street || '';
            const houseNumber = currentRow?.house_number || '';
            
            const values = [[
                chatId,
                `'${lastPingTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                lightState ? 'TRUE' : 'FALSE',
                `'${lightStartTime.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                previousDuration ? previousDuration.toFormat("hh:mm:ss") : '',
                pinnedMessageId,
                city,
                street,
                houseNumber
            ]];

            if (row) {
                // Обновляем существующую строку
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A${row}:I${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                });
            } else {
                // Добавляем новую строку
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:I`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
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
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:I`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                return null;
            }

            // Ищем строку с нужным chat_id (пропускаем заголовок)
            const dataRow = rows.slice(1).find(row => row[0] === String(chatId));
            
            if (!dataRow) {
                return null;
            }

            return {
                chat_id: dataRow[0],
                last_ping_time: dataRow[1],
                light_state: dataRow[2] === 'TRUE' || dataRow[2] === 'true' || dataRow[2] === true,
                light_start_time: dataRow[3],
                previous_duration: dataRow[4] || null,
                pinned_message_id: dataRow[5] || null,
                city: dataRow[6] || '',
                street: dataRow[7] || '',
                house_number: dataRow[8] || ''
            };
        } catch (error) {
            this.logger.error(`Ошибка чтения из Google Sheets: ${error.message}`);
            return null;
        }
    }

    async getAllLightStates() {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:I`,
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                return [];
            }

            // Преобразуем все строки (кроме заголовка) в объекты
            return rows.slice(1).map(row => ({
                chat_id: row[0],
                last_ping_time: row[1],
                light_state: row[2] === 'TRUE' || row[2] === 'true' || row[2] === true,
                light_start_time: row[3],
                previous_duration: row[4] || null,
                pinned_message_id: row[5] || null,
                city: row[6] || '',
                street: row[7] || '',
                house_number: row[8] || ''
            }));
        } catch (error) {
            this.logger.error(`Ошибка чтения всех данных из Google Sheets: ${error.message}`);
            return [];
        }
    }

    async findRowByChatId(chatId) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${this.sheetName}!A:A`,
            });

            const rows = response.data.values;
            if (!rows) {
                return null;
            }

            // Ищем индекс строки (учитываем что первая строка - заголовок)
            const rowIndex = rows.findIndex((row, index) => index > 0 && row[0] === String(chatId));
            return rowIndex >= 0 ? rowIndex + 1 : null;
        } catch (error) {
            this.logger.error(`Ошибка поиска строки: ${error.message}`);
            return null;
        }
    }

    async saveAddress(chatId, city, street, houseNumber) {
        try {
            const row = await this.findRowByChatId(chatId);
            console.log(`Найденная строка для ${chatId}: ${row}`);
            if (row) {
                // Обновляем существующую строку
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!G${row}:I${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[city, street, houseNumber]] }
                });
                this.logger.info(`Адрес для chat_id ${chatId} сохранен`);
            } else {
                // Создаем новую строку с адресом
                const { DateTime } = require('luxon');
                const now = DateTime.now();
                const values = [[
                    chatId,
                    `'${now.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    'TRUE', // Предполагаем свет включен
                    `'${now.toFormat('dd.MM.yyyy HH:mm:ss')}`,
                    '', // previous_duration
                    '', // pinned_message_id
                    city,
                    street,
                    houseNumber
                ]];
                await this.sheets.spreadsheets.values.append({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!A:I`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values }
                });
                this.logger.info(`Новая строка с адресом для chat_id ${chatId} создана`);
            }
        } catch (error) {
            this.logger.error(`Ошибка сохранения адреса: ${error.message}`);
        }
    }

    async savePinnedMessageId(chatId, pinnedMessageId) {
        try {
            const row = await this.findRowByChatId(chatId);
            if (row) {
                // Обновляем существующую строку
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.spreadsheetId,
                    range: `${this.sheetName}!F${row}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[pinnedMessageId]] }
                });
                this.logger.info(`Pinned message ID для chat_id ${chatId} сохранен`);
            }
        } catch (error) {
            this.logger.error(`Ошибка сохранения pinned message ID: ${error.message}`);
        }
    }
}

module.exports = SheetsDB;
