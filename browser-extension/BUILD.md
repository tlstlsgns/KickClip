# KickClip Extension Build Guide (DEV + PROD)

## Overview

KickClip uses a dual-environment extension workflow: `browser-extension/chromium/` is the DEV source directory loaded as unpacked during development, while PROD is generated to `browser-extension/dist/prod/` and zipped as `browser-extension/dist/kickclip-prod.zip` for distribution.

## One-time setup (keys)

```bash
mkdir -p keys
# DEV key
openssl genrsa -out keys/kickclip-dev.pem 2048
openssl rsa -in keys/kickclip-dev.pem -pubout -outform DER | openssl base64 -A
# PROD key
openssl genrsa -out keys/kickclip-prod.pem 2048
openssl rsa -in keys/kickclip-prod.pem -pubout -outform DER | openssl base64 -A
```

- Store both `.pem` files under `browser-extension/keys/` (gitignored).
- Each `openssl ... base64 -A` output is the manifest `"key"` value (single-line base64 DER).

## Insert keys into manifests

1. Replace `__DEV_KEY_PLACEHOLDER__` in `browser-extension/chromium/manifest.dev.json` with the DEV base64 string.
2. Replace `__PROD_KEY_PLACEHOLDER__` in `browser-extension/chromium/manifest.prod.json` with the PROD base64 string.

## Obtain Extension IDs

1. Load `browser-extension/chromium/` as unpacked in Chrome (`chrome://extensions`).
2. Note the DEV Extension ID.
3. Run PROD build:

```bash
cd browser-extension
npm install
npm run build:prod
```

4. Load `browser-extension/dist/prod/` as unpacked in Chrome.
5. Note the PROD Extension ID.

## Register Extension IDs in GCP

For each environment:

- DEV project: `saveurl-a8593`
- PROD project: `saveurl-prod`

Steps:

1. Go to GCP Console -> APIs & Services -> Credentials.
2. Edit the Chrome Extension OAuth Client.
3. Set the Extension ID to the environment-specific ID.

For PROD:

- Create a PROD OAuth Client first (if missing).
- Replace `__PROD_OAUTH_CLIENT_ID_PLACEHOLDER__` in `browser-extension/chromium/manifest.prod.json` with the real PROD client ID.

## Enable Firebase Google Auth for PROD

1. Open Firebase Console for project `saveurl-prod`.
2. Go to Authentication -> Sign-in method.
3. Enable Google provider.

## Build and distribute

```bash
cd browser-extension
npm install
npm run build:prod
```

Outputs:

- `browser-extension/dist/prod/` (loadable unpacked PROD extension folder)
- `browser-extension/dist/kickclip-prod.zip` (distribution zip for early users)

If placeholders are still present in `manifest.prod.json`, the build script prints a warning but still creates output.

## 고객용 설치 가이드

1. zip 파일 압축 해제
2. Chrome 주소창에 `chrome://extensions` 입력
3. 우측 상단 "개발자 모드" 활성화
4. "압축해제된 확장 프로그램을 로드합니다" 클릭 -> 압축 해제한 폴더 선택
5. 확장 프로그램 아이콘 클릭 -> 로그인
