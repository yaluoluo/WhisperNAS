import { TrimApp } from '@trimjs/web-app';

// Official fnOS micro-app JS SDK: provides the native file/directory picker.
window.whisperTrimSdk = new TrimApp();
window.dispatchEvent(new Event('whisper-trim-sdk-ready'));
