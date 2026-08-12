#!/bin/bash
# 앱 상세 소개 이미지(store-assets/detail.png) 생성
# 기존 store-assets(hero/feature1/feature2)를 재사용해 세로형 상세 소개 이미지로 조합한다.
set -euo pipefail

cd "$(dirname "$0")/.."
ASSETS=store-assets
FONT=/System/Library/Fonts/AppleSDGothicNeo.ttc
W=1640
PAD=140
BG='#0F1B2E'
SUB='#9AA7B9'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 텍스트 섹션 이미지 생성: $1=내용, $2=글자색, $3=포인트사이즈
text_section() {
  local content="$1" color="$2" size="$3"
  magick -background "$BG" -fill "$color" -font "$FONT" -pointsize "$size" \
    -size $((W - PAD*2))x caption:"$content" \
    -bordercolor "$BG" -border ${PAD}x${PAD} \
    "$TMP/sec.png"
  echo "$TMP/sec.png"
}

# --- 1. 상단 히어로 ---
cp "$ASSETS/hero.png" "$TMP/01.png"

# --- 2. 기능 이미지 1 ---
cp "$ASSETS/feature1.png" "$TMP/02.png"

# --- 3. 기능 이미지 2 ---
cp "$ASSETS/feature2.png" "$TMP/03.png"

# --- 4. 가볍게 만들었습니다 ---
magick -background "$BG" -fill white -font "$FONT" -pointsize 40 -gravity center \
  -size ${W}x160 caption:"가볍게 만들었습니다" \
  -bordercolor "$BG" -border 0x60 \
  "$TMP/04a.png"
text_section "· 설치 즉시 동작합니다. 소스 수정이 필요 없습니다.
· 상세페이지를 느리게 만들지 않습니다.
· 작성자 이름은 자동으로 가려집니다." "#E6EAF0" 28 \
  > "$TMP/04b.txt"
mv "$TMP/sec.png" "$TMP/04b.png"

# --- 5. 문의 ---
magick -background "$BG" -fill '#C1B49B' -font "$FONT" -pointsize 30 -gravity center \
  -size ${W}x140 caption:"설치·이용 문의는 앱 하단 [문의하기]로 남겨주세요. 영업일 기준 2일 이내에 답변드립니다." \
  -bordercolor "$BG" -border 0x60 \
  "$TMP/05.png"

# --- 조합 ---
magick "$TMP/01.png" "$TMP/02.png" "$TMP/03.png" \
  "$TMP/04a.png" "$TMP/04b.png" "$TMP/05.png" \
  -background "$BG" -append "$ASSETS/detail.png"

sips -g pixelWidth -g pixelHeight "$ASSETS/detail.png"
