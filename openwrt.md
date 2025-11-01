Откройте файл:
vi /usr/bin/ping.lua

Вставьте следующий код:

while true do
    os.execute("wget -O- 'https://wrtping.glitch.me/ping?chat_id=558625598'")
    os.execute("sleep 60")
end


Запустите скрипт через Lua:( не обязательно)

lua /usr/bin/ping.lua &


Чтобы скрипт запускался автоматически при старте роутера на OpenWRT, можно добавить его в файл /etc/rc.local. Вот как это сделать:

Откройте файл /etc/rc.local для редактирования:


vi /etc/rc.local

Добавьте строку для запуска вашего скрипта перед строкой exit 0. Например:


lua /usr/bin/ping.lua &
Это должно выглядеть так:

#!/bin/sh
# This script is executed at the end of the boot process.
# You can add your own commands below.

lua /usr/bin/ping.lua &

exit 0
Сохраните изменения и выйдите из редактора.



Чтобы остановить выполнение скрипта, выполните следующие шаги:

Найдите идентификатор процесса (PID) скрипта:

ps | grep ping.lua


и выбрать 

kill 1527