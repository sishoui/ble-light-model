/*
 * 极简 JSON DOM 解析器 + vectors.json 装载（仅测试用）。
 *
 * 支持 vectors.json 用到的全部语法：null / bool / number / string（含 \uXXXX）/
 * array / object。向量里 hex 串结构化程度高，解析失败直接报错退出，不做容错。
 */

#include "vectors_json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    JSON_NULL = 'n',
    JSON_BOOL = 'b',
    JSON_NUM = 'd',
    JSON_STR = 's',
    JSON_ARR = 'a',
    JSON_OBJ = 'o',
};

struct json_value {
    char type;
    double num;
    int boolean;
    char *str;
    /* array */
    json_value_t **items;
    int n_items;
    /* object */
    char **keys;
    json_value_t **values;
    int n_members;
};

typedef struct {
    const char *p;
    int failed;
} parser_t;

static json_value_t *parse_value(parser_t *ps);

static void *xmalloc(size_t n)
{
    void *p = malloc(n);
    if (p == NULL) {
        fprintf(stderr, "vectors_json: 内存不足\n");
        exit(2);
    }
    return p;
}

static void skip_ws(parser_t *ps)
{
    while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r') {
        ps->p++;
    }
}

static int hex_val(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* 解析字符串字面量（*ps->p == '"'），返回 malloc 的未转义字节串。 */
static char *parse_string_raw(parser_t *ps)
{
    size_t cap = 32;
    size_t len = 0;
    char *out = xmalloc(cap);

    ps->p++; /* 跳过开引号 */
    while (*ps->p != '\0' && *ps->p != '"') {
        char c = *ps->p++;
        if (c == '\\' && *ps->p != '\0') {
            char e = *ps->p++;
            if (e == 'u') {
                unsigned cp = 0;
                int i;
                for (i = 0; i < 4; i++) {
                    int h = hex_val(ps->p[i]);
                    if (h < 0) {
                        ps->failed = 1;
                        free(out);
                        return NULL;
                    }
                    cp = cp * 16u + (unsigned)h;
                }
                ps->p += 4;
                /* 编码为 UTF-8 */
                if (cp < 0x80) {
                    c = (char)cp;
                } else if (cp < 0x800) {
                    if (len + 2 + 1 > cap) { cap *= 2; out = realloc(out, cap); if (!out) exit(2); }
                    out[len++] = (char)(0xC0u | (cp >> 6));
                    out[len++] = (char)(0x80u | (cp & 0x3Fu));
                    continue;
                } else {
                    if (len + 3 + 1 > cap) { cap *= 2; out = realloc(out, cap); if (!out) exit(2); }
                    out[len++] = (char)(0xE0u | (cp >> 12));
                    out[len++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
                    out[len++] = (char)(0x80u | (cp & 0x3Fu));
                    continue;
                }
            } else if (e == 'n') {
                c = '\n';
            } else if (e == 'r') {
                c = '\r';
            } else if (e == 't') {
                c = '\t';
            } else if (e == 'b') {
                c = '\b';
            } else if (e == 'f') {
                c = '\f';
            } else {
                c = e; /* \" \\ \/ 及其他 */
            }
        }
        if (len + 1 + 1 > cap) {
            cap *= 2;
            out = realloc(out, cap);
            if (!out) exit(2);
        }
        out[len++] = c;
    }
    if (*ps->p == '"') {
        ps->p++;
    } else {
        ps->failed = 1;
    }
    out[len] = '\0';
    return out;
}

static json_value_t *new_value(char type)
{
    json_value_t *v = xmalloc(sizeof(*v));
    memset(v, 0, sizeof(*v));
    v->type = type;
    return v;
}

static json_value_t *parse_array(parser_t *ps)
{
    json_value_t *v = new_value(JSON_ARR);
    int cap = 4;

    ps->p++; /* '[' */
    v->items = xmalloc(sizeof(*v->items) * (size_t)cap);
    skip_ws(ps);
    if (*ps->p == ']') {
        ps->p++;
        return v;
    }
    for (;;) {
        json_value_t *item = parse_value(ps);
        if (ps->failed || item == NULL) {
            json_free(v);
            return NULL;
        }
        if (v->n_items == cap) {
            cap *= 2;
            v->items = realloc(v->items, sizeof(*v->items) * (size_t)cap);
            if (!v->items) exit(2);
        }
        v->items[v->n_items++] = item;
        skip_ws(ps);
        if (*ps->p == ',') {
            ps->p++;
            continue;
        }
        if (*ps->p == ']') {
            ps->p++;
            return v;
        }
        ps->failed = 1;
        json_free(v);
        return NULL;
    }
}

static json_value_t *parse_object(parser_t *ps)
{
    json_value_t *v = new_value(JSON_OBJ);
    int cap = 4;

    ps->p++; /* '{' */
    v->keys = xmalloc(sizeof(*v->keys) * (size_t)cap);
    v->values = xmalloc(sizeof(*v->values) * (size_t)cap);
    skip_ws(ps);
    if (*ps->p == '}') {
        ps->p++;
        return v;
    }
    for (;;) {
        char *key;
        json_value_t *item;

        skip_ws(ps);
        if (*ps->p != '"') {
            ps->failed = 1;
            json_free(v);
            return NULL;
        }
        key = parse_string_raw(ps);
        if (ps->failed || key == NULL) {
            json_free(v);
            return NULL;
        }
        skip_ws(ps);
        if (*ps->p != ':') {
            free(key);
            ps->failed = 1;
            json_free(v);
            return NULL;
        }
        ps->p++;
        item = parse_value(ps);
        if (ps->failed || item == NULL) {
            free(key);
            json_free(v);
            return NULL;
        }
        if (v->n_members == cap) {
            cap *= 2;
            v->keys = realloc(v->keys, sizeof(*v->keys) * (size_t)cap);
            v->values = realloc(v->values, sizeof(*v->values) * (size_t)cap);
            if (!v->keys || !v->values) exit(2);
        }
        v->keys[v->n_members] = key;
        v->values[v->n_members] = item;
        v->n_members++;
        skip_ws(ps);
        if (*ps->p == ',') {
            ps->p++;
            continue;
        }
        if (*ps->p == '}') {
            ps->p++;
            return v;
        }
        ps->failed = 1;
        json_free(v);
        return NULL;
    }
}

static json_value_t *parse_value(parser_t *ps)
{
    json_value_t *v;

    skip_ws(ps);
    if (ps->failed) return NULL;

    if (*ps->p == '"') {
        v = new_value(JSON_STR);
        v->str = parse_string_raw(ps);
        if (ps->failed) {
            json_free(v);
            return NULL;
        }
        return v;
    }
    if (*ps->p == '{') return parse_object(ps);
    if (*ps->p == '[') return parse_array(ps);
    if (strncmp(ps->p, "null", 4) == 0) {
        ps->p += 4;
        return new_value(JSON_NULL);
    }
    if (strncmp(ps->p, "true", 4) == 0) {
        ps->p += 4;
        v = new_value(JSON_BOOL);
        v->boolean = 1;
        return v;
    }
    if (strncmp(ps->p, "false", 5) == 0) {
        ps->p += 5;
        return new_value(JSON_BOOL);
    }
    if (*ps->p == '-' || (*ps->p >= '0' && *ps->p <= '9')) {
        char *end = NULL;
        v = new_value(JSON_NUM);
        v->num = strtod(ps->p, &end);
        if (end == ps->p) {
            ps->failed = 1;
            json_free(v);
            return NULL;
        }
        ps->p = end;
        return v;
    }
    ps->failed = 1;
    return NULL;
}

json_value_t *json_parse(const char *text)
{
    parser_t ps;
    json_value_t *v;

    ps.p = text;
    ps.failed = 0;
    v = parse_value(&ps);
    if (ps.failed || v == NULL) return NULL;
    return v;
}

void json_free(json_value_t *v)
{
    int i;

    if (v == NULL) return;
    free(v->str);
    for (i = 0; i < v->n_items; i++) json_free(v->items[i]);
    free(v->items);
    for (i = 0; i < v->n_members; i++) {
        free(v->keys[i]);
        json_free(v->values[i]);
    }
    free(v->keys);
    free(v->values);
    free(v);
}

int json_is(const json_value_t *v, char type)
{
    return v != NULL && v->type == type;
}

const char *json_str(const json_value_t *v)
{
    return (v != NULL && v->type == JSON_STR) ? v->str : NULL;
}

int json_int(const json_value_t *v)
{
    return (v != NULL && v->type == JSON_NUM) ? (int)v->num : 0;
}

int json_bool(const json_value_t *v)
{
    return (v != NULL && v->type == JSON_BOOL) ? v->boolean : 0;
}

const json_value_t *json_get(const json_value_t *obj, const char *key)
{
    int i;

    if (obj == NULL || obj->type != JSON_OBJ) return NULL;
    for (i = 0; i < obj->n_members; i++) {
        if (strcmp(obj->keys[i], key) == 0) return obj->values[i];
    }
    return NULL;
}

const json_value_t *json_array_item(const json_value_t *arr, int index)
{
    if (arr == NULL || arr->type != JSON_ARR || index < 0 || index >= arr->n_items) return NULL;
    return arr->items[index];
}

int json_array_size(const json_value_t *arr)
{
    return (arr != NULL && arr->type == JSON_ARR) ? arr->n_items : 0;
}

/* ---------- hex 工具 ---------- */

int hex_decode(const char *hex, uint8_t *out, size_t out_cap)
{
    size_t n = strlen(hex);
    size_t i;

    if (n % 2 != 0 || n / 2 > out_cap) return -1;
    for (i = 0; i < n / 2; i++) {
        int hi = hex_val(hex[2 * i]);
        int lo = hex_val(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)(hi * 16 + lo);
    }
    return (int)(n / 2);
}

void hex_encode(const uint8_t *in, size_t len, char *out)
{
    static const char digits[] = "0123456789ABCDEF";
    size_t i;

    for (i = 0; i < len; i++) {
        out[2 * i] = digits[in[i] >> 4];
        out[2 * i + 1] = digits[in[i] & 0x0Fu];
    }
    out[2 * len] = '\0';
}

/* ---------- vectors.json 装载 ---------- */

static void copy_str(char *dst, size_t cap, const json_value_t *v, const char *id, const char *field)
{
    const char *s = json_str(v);
    if (s == NULL) {
        fprintf(stderr, "vectors_json: %s 缺字符串字段 %s\n", id, field);
        exit(2);
    }
    if (strlen(s) >= cap) {
        fprintf(stderr, "vectors_json: %s.%s 超长\n", id, field);
        exit(2);
    }
    strcpy(dst, s);
}

static int load_frame(const json_value_t *obj, vec_frame_t *out, const char *id, const char *field)
{
    const json_value_t *ver = json_get(obj, "ver");
    const json_value_t *seq = json_get(obj, "seq");
    const json_value_t *type = json_get(obj, "type");
    const json_value_t *flags = json_get(obj, "flags");
    const json_value_t *strip = json_get(obj, "strip_mask");
    const json_value_t *payload = json_get(obj, "payload");
    const char *hex;

    if (!json_is(ver, 'd') || !json_is(seq, 'd') || !json_is(type, 'd') ||
        !json_is(flags, 'd') || !json_is(strip, 'd') || !json_is(payload, 's')) {
        fprintf(stderr, "vectors_json: %s.%s 帧字段缺失或类型错\n", id, field);
        return -1;
    }
    hex = json_str(payload);
    out->ver = json_int(ver);
    out->seq = json_int(seq);
    out->type = json_int(type);
    out->flags = json_int(flags);
    out->strip_mask = json_int(strip);
    out->payload_len = hex_decode(hex, out->payload, sizeof(out->payload));
    if (out->payload_len < 0) {
        fprintf(stderr, "vectors_json: %s.%s payload hex 非法\n", id, field);
        return -1;
    }
    return 0;
}

static int load_error(const json_value_t *obj, vec_error_t *out, const char *id)
{
    const json_value_t *kind = json_get(obj, "kind");
    const json_value_t *error = json_get(obj, "error");
    const json_value_t *seq = json_get(obj, "seq");
    const json_value_t *type = json_get(obj, "type");

    if (!json_is(kind, 's') || !json_is(error, 'd') || !json_is(seq, 'd') || !json_is(type, 'd')) {
        fprintf(stderr, "vectors_json: %s 错误字段缺失或类型错\n", id);
        return -1;
    }
    copy_str(out->kind, sizeof(out->kind), kind, id, "kind");
    out->error = json_int(error);
    out->seq = json_int(seq);
    out->type = json_int(type);
    return 0;
}

int vectors_load(const char *path, vec_doc_t *out)
{
    FILE *f;
    long sz;
    char *text;
    json_value_t *root;
    const json_value_t *vectors;
    int count;
    int i;

    memset(out, 0, sizeof(*out));

    f = fopen(path, "rb");
    if (f == NULL) {
        fprintf(stderr, "vectors_json: 无法打开 %s\n", path);
        return -1;
    }
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) {
        fclose(f);
        return -1;
    }
    text = xmalloc((size_t)sz + 1);
    if (fread(text, 1, (size_t)sz, f) != (size_t)sz) {
        fclose(f);
        free(text);
        return -1;
    }
    text[sz] = '\0';
    fclose(f);

    root = json_parse(text);
    free(text);
    if (root == NULL || !json_is(root, 'o')) {
        fprintf(stderr, "vectors_json: %s 顶层不是对象\n", path);
        json_free(root);
        return -1;
    }

    vectors = json_get(root, "vectors");
    count = json_array_size(vectors);
    if (count <= 0 || count > 1000) {
        fprintf(stderr, "vectors_json: vectors 数组缺失或数量异常\n");
        json_free(root);
        return -1;
    }
    out->cases = calloc((size_t)count, sizeof(*out->cases));
    if (out->cases == NULL) {
        json_free(root);
        return -1;
    }

    for (i = 0; i < count; i++) {
        const json_value_t *cv = json_array_item(vectors, i);
        const json_value_t *kind;
        const json_value_t *writes;
        const json_value_t *frames;
        const json_value_t *errors;
        const json_value_t *remainders;
        vec_case_t *c = &out->cases[out->count];
        int j;

        if (!json_is(cv, 'o')) {
            fprintf(stderr, "vectors_json: vectors[%d] 不是对象\n", i);
            goto fail;
        }
        copy_str(c->id, sizeof(c->id), json_get(cv, "id"), "vectors[]", "id");
        {
            const json_value_t *desc = json_get(cv, "desc");
            if (json_is(desc, 's')) {
                copy_str(c->desc, sizeof(c->desc), desc, c->id, "desc");
            }
        }
        kind = json_get(cv, "kind");
        if (json_str(kind) != NULL && strcmp(json_str(kind), "encode") == 0) {
            c->is_encode = 1;
            if (load_frame(json_get(cv, "frame"), &c->frame, c->id, "frame") != 0) goto fail;
            copy_str(c->expect_hex, sizeof(c->expect_hex), json_get(cv, "expect_hex"), c->id, "expect_hex");
        } else if (json_str(kind) != NULL && strcmp(json_str(kind), "feed") == 0) {
            c->is_encode = 0;
            writes = json_get(cv, "writes");
            if (!json_is(writes, 'a')) {
                fprintf(stderr, "vectors_json: %s 缺 writes\n", c->id);
                goto fail;
            }
            c->write_count = json_array_size(writes);
            if (c->write_count > VEC_MAX_WRITES) {
                fprintf(stderr, "vectors_json: %s writes 超上限\n", c->id);
                goto fail;
            }
            for (j = 0; j < c->write_count; j++) {
                const char *hex = json_str(json_array_item(writes, j));
                if (hex == NULL || strlen(hex) >= VEC_HEX_MAX) {
                    fprintf(stderr, "vectors_json: %s writes[%d] 非法\n", c->id, j);
                    goto fail;
                }
                strcpy(c->writes[j], hex);
            }
            frames = json_get(cv, "expect_frames");
            if (!json_is(frames, 'a')) {
                fprintf(stderr, "vectors_json: %s 缺 expect_frames\n", c->id);
                goto fail;
            }
            c->expect_frame_count = json_array_size(frames);
            if (c->expect_frame_count > VEC_MAX_FRAMES) {
                fprintf(stderr, "vectors_json: %s expect_frames 超上限\n", c->id);
                goto fail;
            }
            for (j = 0; j < c->expect_frame_count; j++) {
                if (load_frame(json_array_item(frames, j), &c->expect_frames[j], c->id, "expect_frames") != 0) goto fail;
            }
            errors = json_get(cv, "expect_errors");
            if (!json_is(errors, 'a')) {
                fprintf(stderr, "vectors_json: %s 缺 expect_errors\n", c->id);
                goto fail;
            }
            c->expect_error_count = json_array_size(errors);
            if (c->expect_error_count > VEC_MAX_ERRORS) {
                fprintf(stderr, "vectors_json: %s expect_errors 超上限\n", c->id);
                goto fail;
            }
            for (j = 0; j < c->expect_error_count; j++) {
                if (load_error(json_array_item(errors, j), &c->expect_errors[j], c->id) != 0) goto fail;
            }
            remainders = json_get(cv, "expect_remainders");
            if (json_is(remainders, 'a')) {
                for (j = 0; j < c->write_count && j < json_array_size(remainders); j++) {
                    const char *hex = json_str(json_array_item(remainders, j));
                    if (hex == NULL || strlen(hex) >= VEC_HEX_MAX) {
                        fprintf(stderr, "vectors_json: %s expect_remainders[%d] 非法\n", c->id, j);
                        goto fail;
                    }
                    strcpy(c->expect_remainders[j], hex);
                }
            }
            {
                const json_value_t *ack = json_get(cv, "expect_ack_generated");
                if (json_is(ack, 'b')) {
                    c->has_expect_ack_generated = 1;
                    c->expect_ack_generated = json_bool(ack);
                }
            }
        } else {
            fprintf(stderr, "vectors_json: %s kind 未知\n", c->id);
            goto fail;
        }
        out->count++;
        continue;

    fail:
        json_free(root);
        vectors_free(out);
        return -1;
    }

    json_free(root);
    return 0;
}

void vectors_free(vec_doc_t *doc)
{
    free(doc->cases);
    doc->cases = NULL;
    doc->count = 0;
}