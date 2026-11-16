/**
 * ULID（单调，进程内计数器防同毫秒碰撞）—— 架构设计 §3.19。
 * 跨进程同毫秒碰撞由 80 bit 随机段承担（~2^-80）；邮箱消费以 rename 原子认领兜底
 * （架构设计 §3.5，评审 P2-13）。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32，无 I/L/O/U

let lastTime = -1;
let lastRandom = '';

function encodeTime(time: number): string {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function randomString(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(Math.random() * 32)];
  return out;
}

/** 生成单调 ULID（26 字符，Crockford base32 大写）。 */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    // 同毫秒：递增随机段（单调性）；计数器耗尽概率忽略不计
    const chars = lastRandom.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      const idx = ALPHABET.indexOf(chars[i]!);
      if (idx < 31) {
        chars[i] = ALPHABET[idx + 1]!;
        break;
      }
      chars[i] = ALPHABET[0]!;
    }
    lastRandom = chars.join('');
  } else {
    lastTime = now;
    lastRandom = randomString(16);
  }
  return encodeTime(now) + lastRandom;
}

/** 会话 ID 完整形态（`ses_` + 26 字母数字，1.4 §2 [S] session-id.ts：降序 ULID 风格）。
 * 实测（2026-11-16）：平台校验要求 "ses" 前缀——此前小写无前缀形态被拒。 */
export function sessionId(): string {
  return 'ses_' + ulid();
}

/** OpenCode 消息 ID 形态（`^msg_`，1.4 §2 [A]）。 */
export function messageId(): string {
  return 'msg_' + ulid();
}
