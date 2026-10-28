#!/usr/bin/env bash
# Установка на VPS (Debian/Ubuntu). Запуск: PASSWORD=твой_пароль bash vps-setup.sh
set -e
: "${PASSWORD:?Задай пароль: PASSWORD=... bash vps-setup.sh}"
BRANCH=ccr-1b774c8b-uj3cfj
DIR=/opt/dpl
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ffmpeg ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
rm -rf "$DIR"
git clone -b "$BRANCH" https://github.com/mlwareCodinK/Spilauchka.github.io.git "$DIR"
cd "$DIR"
npm install
npx playwright install --with-deps chromium
cat > /etc/systemd/system/dpl.service <<EOF
[Unit]
Description=DPlayer downloader
After=network.target
[Service]
WorkingDirectory=$DIR
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=PASSWORD=$PASSWORD
ExecStart=$(command -v node) server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dpl
command -v ufw >/dev/null && ufw allow 3000/tcp || true
echo "Готово: http://$(curl -s ifconfig.me):3000  (логин любой, пароль — тот, что задал)"
