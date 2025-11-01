const axios = require('axios');

const fetchData = async (city, street, houseNumber) => {
  const url = 'https://www.dtek-oem.com.ua/ua/ajax';
  const data = new URLSearchParams({
    'method': 'getHomeNum',
    'data[0][name]': 'city',
    'data[0][value]': city,
    'data[1][name]': 'street',
    'data[1][value]': street,
    'data[2][name]': 'home_num',
    'data[2][value]': houseNumber
  });

  const headers = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7,uk-UA;q=0.6,uk;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Dnt': '1',
    'Origin': 'https://www.dtek-oem.com.ua',
    'Referer': 'https://www.dtek-oem.com.ua/ua/shutdowns',
    'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'X-Csrf-Token': 'lp57xTMUPwlYiISQe8MwPDb5EW4VktjS-YAkAcV3qG2u2CynRH1IWAC5sahWsF4MAbZDKCPCiKir70owlUfnCg==',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': 'Domain=dtek-oem.com.ua; visid_incap_2398477=f5jDijOISVK1Dx0Oh7YXdHvhfWYAAAAAQUIPAAAAAAAICT5dgkqLY3UAA/OB8YI3; _ga=GA1.1.2113640342.1719525756; _ga_B5BT53GY2T=GS1.1.1719525755.1.1.1719526236.60.0.0; SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTE0LjA2X3AwGgJmaSADGgYIgOu0sgY; dtek-oem=haci8ogkc8c7rj8rkphsneh2e9; _language=4feef5ffdc846bbf9c35c97292b7b3e6c48117a536a6462b530e0984a39d6bd4a%3A2%3A%7Bi%3A0%3Bs%3A9%3A%22_language%22%3Bi%3A1%3Bs%3A2%3A%22uk%22%3B%7D; incap_ses_324_2398477=3r5QERXqeWpvRvniWBR/BD11OmcAAAAA7EeCt6p5m94cheDCOU+dyg==; _csrf-dtek-oem=cabcd6691868d637088cb424cb213a8d930285190f2abc59c3c1a5cd55f19724a%3A2%3A%7Bi%3A0%3Bs%3A14%3A%22_csrf-dtek-oem%22%3Bi%3A1%3Bs%3A32%3A%228FWbwiwQX158-sn07ORF6PPzRon1P0Og%22%3B%7D; Domain=dtek-oem.com.ua; incap_wrt_377=W3U6ZwAAAADjx8U9GQAI+QIQq+nvqjsYh+3puQYgAii96um5BjABoTQgB/gfNf+Z/4URKHu2zA==',
  };

  try {
    const response = await axios.post(url, data.toString(), { headers });
    const { result, data: responseData, updateTimestamp } = response.data;

    if (result) {
      return {
        data: responseData,
        updateTimestamp
      };
    } else {
      return null;
    }
  } catch (error) {
    console.error('Ошибка запроса:', error.message);
    return null;
  }
};

module.exports = fetchData;
