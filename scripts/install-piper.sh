#!/bin/sh
# Piper (yerel Türkçe TTS) kurulumu — derleme sırasında çalışır; sonuç imajın içinde kalır,
# bu yüzden Coolify yeniden dağıtımında Piper silinmez. Ses verisi dışarı çıkmaz.
# Sürümler sabitlenmiştir; indirme doğrulanamazsa derleme KIRILIR (sessiz ajan istemeyiz).
set -eu

PIPER_VERSION="2023.11.14-2"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium"
DEST="${PIPER_DEST:-/opt}"

mkdir -p "${DEST}/piper-sesler"
curl -fsSL "${PIPER_URL}" -o /tmp/piper.tar.gz
tar -xzf /tmp/piper.tar.gz -C "${DEST}"
rm -f /tmp/piper.tar.gz

for f in tr_TR-dfki-medium.onnx tr_TR-dfki-medium.onnx.json; do
  curl -fsSL "${VOICE_BASE}/${f}" -o "${DEST}/piper-sesler/${f}"
done

# Doğrulama: ikili çalışıyor mu, model gerçekten ses üretiyor mu?
BYTES=$(echo "Merhaba" | "${DEST}/piper/piper" --model "${DEST}/piper-sesler/tr_TR-dfki-medium.onnx" --output_raw 2>/dev/null | wc -c)
if [ "${BYTES}" -lt 10000 ]; then
  echo "Piper doğrulaması BAŞARISIZ (${BYTES} bayt ses)" >&2
  exit 1
fi
echo "Piper hazır: ${BYTES} bayt deneme sesi"
