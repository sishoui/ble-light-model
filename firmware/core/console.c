/*
 * 串口测试指令解析实现（纯 C99，纯函数）。
 * 语法见 console.h 文件头。解析器只分类 + 校验参数个数（期望长度复用
 * ble_proto 长度表，全仓一份），不做语义校验 —— 语义由 effect_apply
 * 在 app 层报 NAK 同款错误码。
 */

#include "console.h"

#include <string.h>

#include "ble_proto.h"

static int is_space(char c)
{
    return c == ' ' || c == '\t';
}

/* 十六进制字节：两位十六进制或 0x 前缀。成功返回 0 并写 *out。 */
static int parse_hex_byte(const char *s, size_t len, uint8_t *out)
{
    unsigned v = 0;
    unsigned digits = 0;
    size_t i = 0;

    if (len >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
        i = 2;
    }
    for (; i < len; i++) {
        char c = s[i];
        v <<= 4;
        if (c >= '0' && c <= '9') {
            v |= (unsigned)(c - '0');
        } else if (c >= 'a' && c <= 'f') {
            v |= (unsigned)(c - 'a' + 10);
        } else if (c >= 'A' && c <= 'F') {
            v |= (unsigned)(c - 'A' + 10);
        } else {
            return -1;
        }
        digits++;
        if (digits > 2) {
            return -1; /* 超过一个字节 */
        }
    }
    if (digits == 0) {
        return -1;
    }
    *out = (uint8_t)v;
    return 0;
}

/* 十进制 0..255。 */
static int parse_dec_byte(const char *s, size_t len, uint8_t *out)
{
    unsigned v = 0;

    if (len == 0) {
        return -1;
    }
    for (size_t i = 0; i < len; i++) {
        if (s[i] < '0' || s[i] > '9') {
            return -1;
        }
        v = v * 10u + (unsigned)(s[i] - '0');
        if (v > 255u) {
            return -1;
        }
    }
    *out = (uint8_t)v;
    return 0;
}

/* 按空白切词：返回下一个词的 (ptr,len)，推进 *cursor。无更多词返回 len=0。 */
static void next_token(const char **cursor, size_t *remain,
                       const char **tok, size_t *tok_len)
{
    const char *p = *cursor;
    size_t n = *remain;

    while (n > 0 && is_space(*p)) {
        p++;
        n--;
    }
    *tok = p;
    *tok_len = 0;
    while (n > 0 && !is_space(*p)) {
        p++;
        n--;
        (*tok_len)++;
    }
    *cursor = p;
    *remain = n;
}

static int tok_eq(const char *tok, size_t len, const char *lit)
{
    size_t n = strlen(lit);
    if (len != n) {
        return 0;
    }
    for (size_t i = 0; i < n; i++) {
        char a = tok[i];
        char b = lit[i];
        if (a >= 'A' && a <= 'Z') {
            a = (char)(a - 'A' + 'a');
        }
        if (b >= 'A' && b <= 'Z') {
            b = (char)(b - 'A' + 'a');
        }
        if (a != b) {
            return 0;
        }
    }
    return 1;
}

static void set_error(console_action_t *out, uint8_t code)
{
    out->type = CONSOLE_ACT_ERROR;
    out->error_code = code;
}

void console_parse_line(const char *line, size_t len, console_action_t *out)
{
    const char *cur = line;
    size_t remain = len;
    const char *cmd;
    size_t cmd_len;

    memset(out, 0, sizeof(*out));

    next_token(&cur, &remain, &cmd, &cmd_len);
    if (cmd_len == 0) {
        out->type = CONSOLE_ACT_NONE;
        return;
    }

    if (tok_eq(cmd, cmd_len, "SET")) {
        const char *t;
        size_t tl;
        uint8_t mask, effect_id;
        int expected;

        next_token(&cur, &remain, &t, &tl);
        if (parse_hex_byte(t, tl, &mask) != 0) {
            set_error(out, CONSOLE_ERR_BAD_ARG);
            return;
        }
        next_token(&cur, &remain, &t, &tl);
        if (parse_hex_byte(t, tl, &effect_id) != 0) {
            set_error(out, CONSOLE_ERR_BAD_ARG);
            return;
        }
        expected = ble_proto_effect_param_length(effect_id);
        if (expected < 0) {
            /* 未知灯效留给 app 层 effect_apply 报 0x03；这里不拦。 */
            out->type = CONSOLE_ACT_SET_EFFECT;
            out->strip_mask = mask;
            out->effect_id = effect_id;
            out->param_len = 0u;
            return;
        }
        out->type = CONSOLE_ACT_SET_EFFECT;
        out->strip_mask = mask;
        out->effect_id = effect_id;

        for (;;) {
            uint8_t v;
            next_token(&cur, &remain, &t, &tl);
            if (tl == 0) {
                break;
            }
            if (out->param_len < BLE_LIGHT_CONSOLE_MAX_PARAMS) {
                if (parse_hex_byte(t, tl, &v) == 0) {
                    out->params[out->param_len] = v;
                    out->param_len++;
                    continue;
                }
                set_error(out, CONSOLE_ERR_BAD_ARG);
                return;
            }
            /* 超出缓冲的参数：忽略多余（与协议 param_len 过长同理）。 */
        }
        if ((int)out->param_len < expected) {
            set_error(out, CONSOLE_ERR_PARAMS_SHORT);
        }
        return;
    }

    if (tok_eq(cmd, cmd_len, "BRI")) {
        const char *t;
        size_t tl;
        uint8_t b;

        next_token(&cur, &remain, &t, &tl);
        if (parse_dec_byte(t, tl, &b) != 0) {
            /* 0..255 之外（如 256、负数）→ 范围错误。 */
            set_error(out, CONSOLE_ERR_BRIGHTNESS_RANGE);
            return;
        }
        out->type = CONSOLE_ACT_SET_BRIGHTNESS;
        out->brightness = b;
        return;
    }

    if (tok_eq(cmd, cmd_len, "SELFTEST") || tok_eq(cmd, cmd_len, "ST")) {
        out->type = CONSOLE_ACT_SELFTEST;
        return;
    }

    if (tok_eq(cmd, cmd_len, "?")) {
        out->type = CONSOLE_ACT_HELP;
        return;
    }

    set_error(out, CONSOLE_ERR_UNKNOWN_CMD);
}