#!/usr/bin/env bash
# زمام — مثبّت بخطوة واحدة على سيرفر Ubuntu/Debian جديد (شغّله كـ root)
#   bash install.sh                      (تفاعلي)
#   DOMAIN=zimam.example.com TZ_NAME=Asia/Riyadh bash install.sh   (بدون أسئلة)
set -e
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "→ تثبيت Docker..."; curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 مطلوب"; exit 1; }
if [ -z "$DOMAIN" ]; then read -rp "الدومين (مثال: zimam.example.com): " DOMAIN; fi
if [ -z "$TZ_NAME" ]; then read -rp "المنطقة الزمنية [Asia/Riyadh]: " TZ_NAME; TZ_NAME=${TZ_NAME:-Asia/Riyadh}; fi
if [ -z "${ANTHROPIC_API_KEY+x}" ]; then read -rp "مفتاح Anthropic (اختياري، اضغط Enter للتخطي): " ANTHROPIC_API_KEY; fi
gen() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ -f .env ]; then
  echo "→ .env موجود، بنستخدمه كما هو"
else
  cat > .env <<ENV
DOMAIN=$DOMAIN
TZ_NAME=$TZ_NAME
WAHA_API_KEY=$(gen)
WEBHOOK_SECRET=$(gen)
ADMIN_SECRET=$(gen)
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
ENV
  chmod 600 .env
fi
echo "→ تشغيل الحاويات (أول مرة بتاخد دقيقتين)..."
docker compose up -d --build
set -a; . ./.env; set +a
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:3030/health" >/dev/null 2>&1 || docker exec zimam wget -qO- http://127.0.0.1:3030/health >/dev/null 2>&1; then break; fi; sleep 3
done
echo
echo "======================================================"
echo " زمام جاهز"
echo " الواجهة:  https://$DOMAIN/app"
echo " المفتاح:  $ADMIN_SECRET"
echo "   (الصقه مرة وحدة في الواجهة: فعّل ← المفتاح)"
echo " الخطوات الجاية: اربط واتساب بالكود من الواجهة، وضيف رقم"
echo " البوت لقروب الفريق واكتب فيه: زمام حضور"
echo "======================================================"
