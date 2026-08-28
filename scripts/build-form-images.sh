#!/bin/bash
# 고도몰 앱스토어 → 판매정보 → 이미지/동영상 폼용 이미지 생성
#
#  1) 대표 이미지  : store-assets/hero.png     (권장 820x480 → 1640x960 @2x)
#  2) 주요 기능 1  : store-assets/feature1.png (엑셀 한 번으로 리뷰 이전)
#  3) 주요 기능 2  : store-assets/feature2.png (작성자 자동 마스킹)
#
# 소스 자산: ../cafe24-review/store-assets/screenshots/ (리뷰이사 앱 실화면 캡처)
#  - app-01-main.png   : 메인 화면 (1. 엑셀 준비 / 2. 상품 선택 / 3. 엑셀 업로드)
#  - app-02-preview.png: 미리보기 화면 (로딩된 구매평 + 마스킹 작성자명 목록)
#  - app-03-done.png   : 완료 화면 (구매평 6건을 옮겼습니다)
# 캡처 상단 헤더(몰명 배지) 영역은 잘라내고 본문 UI만 사용한다.
set -euo pipefail
cd "$(dirname "$0")/.."

ASSETS=store-assets
C24=../cafe24-review/store-assets/screenshots
FONT=/System/Library/Fonts/AppleSDGothicNeo.ttc
MONO=/System/Library/Fonts/Menlo.ttc

W=1640; H=960
BG_TOP='#0F1B2E'; BG_BOT='#1B2E4B'
CARD='#15253D'; CARD2='#121F33'
SUB='#9AA7B9'; GOLD='#C9B37E'; WHITE='#F5F7FA'
DIM='#7E8CA0'
TOP_TRIM=170   # 캡처 상단 몰명 헤더 제거 높이

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

info() { printf '\033[36m%s\033[0m\n' "$*"; }

# ---------- 유틸 ----------

# 텍스트 투명 레이어 (자동 폭, 줄바꿈 없음). 사용: txt <out> <text> <pt> <color> [weight]
txt() {
  magick -background none -font "$FONT" -pointsize "$3" -fill "$4" -weight "${5:-normal}" \
    label:"$2" "$1"
}

# 고정 폭 캡션 (중앙 정렬 줄바꿈). 사용: caption_ <out> <W> <H> <text> <pt> <color> [weight]
caption_() {
  magick -background none -font "$FONT" -pointsize "$5" -fill "$6" -weight "${7:-normal}" \
    -gravity center -size "$2"x"$3" caption:"$4" "$1"
}

# 둥근 모서리 마스크 적용. 사용: rounded <in> <out> <rx>
rounded() {
  local in="$1" out="$2" r="$3" w h
  read -r w h < <(magick "$in" -format '%w %h' info:) || true
  magick -size "${w}x${h}" xc:none -fill white -draw "roundrectangle 0,0,$((w-1)),$((h-1)),$r,$r" "$TMP/mask.png"
  magick "$in" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$out"
}

# 캡처 본문(몰명 헤더 제거) 준비. 사용: body <src> <out> <x> <y> <w> <h>
# <x,y,w,h> = 전체 스크린샷 내 앱 창 bbox (상단 몰명 헤더가 포함된 영역 제외)
body() {
  local src="$1" out="$2" x="$3" y="$4" w="$5" h="$6"
  magick "$src" -crop "${w}x${h}+${x}+${y}" +repage -resize x800 "$out"
}

# ---------- 소스 캡처 준비 (앱 창 bbox) ----------
info "preparing crops…"
# app-01: 창 733x868 at (914,58) → 상단 170px 헤더 제거
body "$C24/app-01-main.png"    "$TMP/s1.png" 914 228 733 698
# app-02: 창 1004x1286 at (778,58) → 상단 170px 헤더 제거
body "$C24/app-02-preview.png" "$TMP/s2.png" 778 228 1004 1116
# app-03: 창 733x1026 at (914,58) → 상단 170px 헤더 제거
body "$C24/app-03-done.png"    "$TMP/s3.png" 914 228 733 856

# ---------- 공통 배경 ----------
make_bg() { # <out>
  magick -size "${W}x${H}" gradient:"${BG_TOP}"-"${BG_BOT}" "$1"
}

###############################################################################
# 1) 대표 이미지 (hero.png) — 카피 레프트 + 브라우저 목업(미리보기 화면)
###############################################################################
info "hero.png…"
make_bg "$TMP/hero.png"
BCAN=$TMP/hero.png

# --- 배지 ---
txt "$TMP/badge.png" '리뷰이사 — 고도몰 리뷰 이관 앱' 26 "$GOLD"
read -r bw bh < <(magick "$TMP/badge.png" -format '%w %h' info:) || true
BPAD=$((bw + 56))
magick -size "${BPAD}x76" xc:none -stroke "$GOLD" -strokewidth 2 \
  -draw "roundrectangle 2,2,$((BPAD-3)),73,38,38" "$TMP/badge_bg.png"
magick "$TMP/badge_bg.png" "$TMP/badge.png" -gravity center -composite "$TMP/badge_f.png"
magick "$BCAN" "$TMP/badge_f.png" -geometry +90+140 -composite "$BCAN"

# --- 헤드라인 (46pt bold, 두 줄) ---
txt "$TMP/h1.png" '쿠팡·네이버 스마트스토어 구매평,' 46 "$WHITE" bold
magick "$BCAN" "$TMP/h1.png" -geometry +90+250 -composite "$BCAN"
txt "$TMP/h2.png" '고도몰 상품 후기로 한 번에' 46 "$WHITE" bold
read -r h2w _ < <(magick "$TMP/h2.png" -format '%w %h' info:) || true
magick "$BCAN" "$TMP/h2.png" -geometry +90+318 -composite "$BCAN"

# --- 서브 (24pt, 두 줄) ---
caption_ "$TMP/sub.png" 800 120 '고도몰 상품 후기에 엑셀 그대로 자동 등록됩니다.
별도 정리·입력 불필요, 작성자 이름은 자동 마스킹.' 24 "$SUB"
magick "$BCAN" "$TMP/sub.png" -geometry +86+416 -composite "$BCAN"

# --- 칩 3종 (① 엑셀 업로드 / ② 미리보기 / ③ 후기 등록) ---
chip() { # <text> <out:name>
  txt "$TMP/chip_$2.png" "$1" 24 "$GOLD" bold
  read -r cw ch < <(magick "$TMP/chip_$2.png" -format '%w %h' info:) || true
  cw=$((cw + 48)); ch=$((ch + 26))
  magick -size "${cw}x${ch}" xc:none -stroke "$GOLD" -strokewidth 2 \
    -draw "roundrectangle 2,2,$((cw-3)),$((ch-3)),$((ch/2)),$((ch/2))" "$TMP/chip_${2}_bg.png"
  magick "$TMP/chip_${2}_bg.png" "$TMP/chip_$2.png" -gravity center -composite "$TMP/chip_${2}_f.png"
}
chip '① 엑셀 업로드' c1
chip '② 미리보기' c2
chip '③ 후기 등록' c3
read -r _ chh < <(magick "$TMP/chip_c1_bg.png" -format '%w %h' info:) || true
CHIPY=600
XOFF=90
for c in c1 c2 c3; do
  read -r cw _ < <(magick "$TMP/chip_${c}_bg.png" -format '%w %h' info:) || true
  magick "$BCAN" "$TMP/chip_${c}_f.png" -geometry +${XOFF}+${CHIPY} -composite "$BCAN"
  XOFF=$((XOFF + cw + 22))
done

# --- 하단 노트 ---
txt "$TMP/note.png" '무료 플랜으로 20건까지 체험해 보세요' 22 "$DIM"
magick "$BCAN" "$TMP/note.png" -geometry +90+$((CHIPY + chh + 26)) -composite "$BCAN"

# --- 오른쪽: 브라우저 목업 (app-02 미리보기 화면, 마스킹 목록 포함) ---
BW2=610; BODY_H=640; BARPAD=44; PAD=22; R=28
CARD_W=$((BW2 + PAD*2)); CARD_H=$((BODY_H + BARPAD + PAD*2))
read -r sw sh < <(magick "$TMP/s2.png" -format '%w %h' info:) || true
# 목업 내부 이미지 폭 → 비율 유지 리사이즈
IMG_W=$((BW2 - 2))
IMG_H=$(( IMG_W * sh / sw ))
# 목업 카드 바탕
magick -size "${CARD_W}x${CARD_H}" xc:none -fill "$CARD" -stroke "$GOLD" -strokewidth 3 \
  -draw "roundrectangle 2,2,$((CARD_W-3)),$((CARD_H-3)),$R,$R" "$TMP/mock_bg.png"
# 브라우저 바 (점 3개 + URL)
magick "$TMP/mock_bg.png" -fill '#FF5F56' -draw "circle $((PAD+12)),$((BARPAD/2)) $((PAD+12+6)),$((BARPAD/2))" \
  -fill '#FFBD2E' -draw "circle $((PAD+34)),$((BARPAD/2)) $((PAD+34+6)),$((BARPAD/2))" \
  -fill '#27C93F' -draw "circle $((PAD+56)),$((BARPAD/2)) $((PAD+56+6)),$((BARPAD/2))" "$TMP/mock_bg.png"
txt "$TMP/url.png" 'godomall-review.vercel.app/admin' 18 "$DIM"
read -r uw uh < <(magick "$TMP/url.png" -format '%w %h' info:) || true
UPAD=$((uw + 40)); URLX=$((CARD_W - UPAD - PAD))
magick "$TMP/mock_bg.png" -fill '#22324A' -draw "roundrectangle $URLX,8,$((URLX+UPAD)),$((BARPAD-8)),14,14" "$TMP/mock_bg.png"
magick "$TMP/mock_bg.png" "$TMP/url.png" -geometry +$((URLX+20))+$((BARPAD/2-uh/2)) -composite "$TMP/mock_bg.png"
# 미리보기 화면을 카드에 클리핑해 얹기
magick "$TMP/s2.png" -resize "${IMG_W}x" "$TMP/mock_img.png"
rounded "$TMP/mock_img.png" "$TMP/mock_img_r.png" 16
magick "$TMP/mock_bg.png" "$TMP/mock_img_r.png" -geometry +${PAD}+${BARPAD} -composite "$TMP/mock.png"
# 오른쪽 정렬 배치 (우측 마진 90)
magick "$BCAN" "$TMP/mock.png" -geometry +$((1640 - CARD_W - 90))+$(( (960 - CARD_H) / 2 )) -composite "$BCAN"
cp "$BCAN" "$ASSETS/hero.png"

###############################################################################
# 2) 주요 기능 1 — 엑셀 한 번으로 리뷰 이전 (3단계 흐름)
###############################################################################
info "feature1.png…"
make_bg "$TMP/f1.png"
BCAN=$TMP/f1.png

txt "$TMP/f1_title.png" '엑셀 한 번으로 리뷰 이전' 46 "$WHITE" bold
read -r tw th < <(magick "$TMP/f1_title.png" -format '%w %h' info:) || true
magick "$BCAN" "$TMP/f1_title.png" -geometry +$(( (W-tw)/2 ))+96 -composite "$BCAN"
caption_ "$TMP/f1_desc.png" 1200 100 '스마트스토어 구매평 엑셀을 올리면 상품 후기로 자동 등록.
별도 정리·입력 불필요.' 24 "$SUB"
magick "$BCAN" "$TMP/f1_desc.png" -geometry +$(( (W-1200)/2 ))+180 -composite "$BCAN"

# 3개 카드 — 동일 이미지 높이, 스크린샷 고유 비율 유지 + 사이 화살표
IMG_H=400; R=24; PAD=16; BAR_H=44; GAP=20
SY=330
CARD_H=$((IMG_H + PAD*2 + BAR_H))
declare -a CARD_W
total=0
for i in 1 2 3; do
  read -r sw sh < <(magick "$TMP/s$i.png" -format '%w %h' info:) || true
  W_i=$(( IMG_H * sw / sh ))
  CARD_W[$i]=$((W_i + PAD*2))
  total=$((total + CARD_W[$i]))
done
total=$((total + GAP*2))
SX=$(( (W - total) / 2 ))

for i in 1 2 3; do
  case $i in
    1) img=$TMP/s1.png; lbl='엑셀 준비' ;;
    2) img=$TMP/s2.png; lbl='미리보기' ;;
    3) img=$TMP/s3.png; lbl='후기 등록' ;;
  esac
  CK_W=${CARD_W[$i]}
  # 카드 바탕
  magick -size "${CK_W}x${CARD_H}" xc:none -fill "$CARD" -stroke '#2C4059' -strokewidth 2 \
    -draw "roundrectangle 2,2,$((CK_W-3)),$((CARD_H-3)),$R,$R" "$TMP/card$i.png"
  # 스크린샷 (상단 단계 바 아래)
  magick "$img" -resize "$((IMG_H))x" "$TMP/ci$i.png"
  rounded "$TMP/ci$i.png" "$TMP/ci${i}_r.png" 18
  magick "$TMP/card$i.png" "$TMP/ci${i}_r.png" -geometry +${PAD}+$((BAR_H+PAD)) -composite "$TMP/card$i.png"
  # 단계 레이블 (카드 상단 골드 바)
  txt "$TMP/cl$i.png" "STEP ${i} · $lbl" 22 "$GOLD" bold
  read -r lw lh < <(magick "$TMP/cl$i.png" -format '%w %h' info:) || true
  magick "$TMP/card$i.png" -fill '#0E1928' -draw "roundrectangle 0,0,$((CK_W-1)),$((BAR_H-1)),18,18" "$TMP/card$i.png"
  magick "$TMP/card$i.png" "$TMP/cl$i.png" -geometry +$((CK_W/2 - lw/2))+$((BAR_H/2 - lh/2)) -composite "$TMP/card$i.png"
  magick "$BCAN" "$TMP/card$i.png" -geometry +${SX}+${SY} -composite "$BCAN"
  SX=$((SX + CK_W + GAP))
done
# 카드 사이 화살표 (이미지 중앙 높이)
ARROW_Y=$((SY + BAR_H + PAD + IMG_H/2))
AX=$(( (W - total) / 2 + CARD_W[1] + GAP/2 ))
for i in 1 2; do
  magick "$BCAN" -stroke "$GOLD" -strokewidth 6 -fill "$GOLD" \
    -draw "line $((AX-10)),$ARROW_Y $((AX+3)),$ARROW_Y" \
    -draw "polygon $((AX+3)),$((ARROW_Y-9)) $((AX+3)),$((ARROW_Y+9)) $((AX+14)),$ARROW_Y" "$BCAN"
  AX=$((AX + CARD_W[$((i+1))] + GAP))
done
cp "$BCAN" "$ASSETS/feature1.png"

###############################################################################
# 3) 주요 기능 2 — 작성자 자동 마스킹
###############################################################################
info "feature2.png…"
make_bg "$TMP/f2.png"
BCAN=$TMP/f2.png

# --- 제목/설명 (왼쪽 상단) ---
txt "$TMP/f2_title.png" '작성자 자동 마스킹' 46 "$WHITE" bold
magick "$BCAN" "$TMP/f2_title.png" -geometry +90+110 -composite "$BCAN"
caption_ "$TMP/f2_desc.png" 720 90 '리뷰 작성자 이름을 마스킹 처리해
개인정보를 보호합니다.' 25 "$SUB"
magick "$BCAN" "$TMP/f2_desc.png" -geometry +86+190 -composite "$BCAN"

# --- 마스킹 변환 카드 (cherry4321 → cher****) ---
ROW_W=760; ROW_H=92; ROW_GAP=24; ROW_Y=330; R=20
mk_row() { # <원본> <마스킹> <idx>
  magick -size "${ROW_W}x${ROW_H}" xc:none -fill "$CARD2" -stroke '#2C4059' -strokewidth 2 \
    -draw "roundrectangle 0,0,$((ROW_W-1)),$((ROW_H-1)),$R,$R" "$TMP/row_$3.png"
  txt "$TMP/nm_$3.png" "$1" 30 "$DIM" bold
  read -r nw nh < <(magick "$TMP/nm_$3.png" -format '%w %h' info:) || true
  magick "$TMP/row_$3.png" "$TMP/nm_$3.png" -geometry +34+$((ROW_H/2-nh/2)) -composite "$TMP/row_$3.png"
  txt "$TMP/ar_$3.png" '→' 34 "$GOLD" bold
  magick "$TMP/row_$3.png" "$TMP/ar_$3.png" -geometry +$((ROW_W/2-17))+$((ROW_H/2-20)) -composite "$TMP/row_$3.png"
  txt "$TMP/mk_$3.png" "$2" 30 "#FFFFFF" bold
  read -r mw mh < <(magick "$TMP/mk_$3.png" -format '%w %h' info:) || true
  magick "$TMP/row_$3.png" "$TMP/mk_$3.png" -geometry +$((ROW_W/2+46))+$((ROW_H/2-mh/2)) -composite "$TMP/row_$3.png"
  magick "$BCAN" "$TMP/row_$3.png" -geometry +90+${ROW_Y} -composite "$BCAN"
  ROW_Y=$((ROW_Y + ROW_H + ROW_GAP))
}
mk_row 'cherry4321' 'cher****' 1
mk_row 'happyface'  'happ****' 2
mk_row 'seoul_buyer' 'seou****' 3

# --- 하단 노트 ---
txt "$TMP/f2_note.png" '저장부터 노출까지 마스킹 유지 · 원본 이름 미보관' 22 "$GOLD"
magick "$BCAN" "$TMP/f2_note.png" -geometry +90+${ROW_Y} -composite "$BCAN"

# --- 오른쪽: 앱 미리보기 화면 카드 (마스킹 작성자명 목록 포함) ---
RW=520; R=24; PAD=16
read -r sw sh < <(magick "$TMP/s2.png" -format '%w %h' info:) || true
IMG_W=$((RW - PAD*2)); IMG_H=$(( IMG_W * sh / sw ))
RH=$((IMG_H + PAD*2))
magick -size "${RW}x${RH}" xc:none -fill "$CARD" -stroke '#2C4059' -strokewidth 2 \
  -draw "roundrectangle 2,2,$((RW-3)),$((RH-3)),$R,$R" "$TMP/f2_card.png"
magick "$TMP/s2.png" -resize "${IMG_W}x" "$TMP/f2_img.png"
rounded "$TMP/f2_img.png" "$TMP/f2_img_r.png" 16
magick "$TMP/f2_card.png" "$TMP/f2_img_r.png" -geometry +${PAD}+${PAD} -composite "$TMP/f2_card.png"
magick "$BCAN" "$TMP/f2_card.png" -geometry +1000+$(( (960-RH)/2 )) -composite "$BCAN"
cp "$BCAN" "$ASSETS/feature2.png"

info "done."
for f in "$ASSETS/hero.png" "$ASSETS/feature1.png" "$ASSETS/feature2.png"; do
  sips -g pixelWidth -g pixelHeight "$f" | tail -2
done