#ifndef BLE_LIGHT_TEST_VECTORS_JSON_H
#define BLE_LIGHT_TEST_VECTORS_JSON_H

#include <stddef.h>
#include <stdint.h>

/*
 * 测试专用：极简 JSON DOM + tests/protocol/vectors.json 装载。
 * 动态内存限制只针对 firmware/proto/ 生产代码；测试代码可用 stdio / malloc。
 */

typedef struct json_value json_value_t;

json_value_t *json_parse(const char *text);
void json_free(json_value_t *v);
const json_value_t *json_get(const json_value_t *obj, const char *key);
const json_value_t *json_array_item(const json_value_t *arr, int index);
int json_array_size(const json_value_t *arr);
int json_is(const json_value_t *v, char type); /* 'n' null 'b' bool 'd' number 's' string 'a' array 'o' object */
const char *json_str(const json_value_t *v);
int json_int(const json_value_t *v);
int json_bool(const json_value_t *v);

/* hex 工具 */
int hex_decode(const char *hex, uint8_t *out, size_t out_cap); /* 返回字节数，-1 非法 */
void hex_encode(const uint8_t *in, size_t len, char *out);     /* out 需 2*len+1 字节 */

/* golden 向量装载（固定上限，向量规模由本仓库决定） */
#define VEC_MAX_WRITES 8
#define VEC_MAX_FRAMES 16
#define VEC_MAX_ERRORS 16
#define VEC_HEX_MAX 1024

typedef struct {
    int ver, seq, type, flags, strip_mask;
    int payload_len;
    uint8_t payload[256];
} vec_frame_t;

typedef struct {
    char kind[24];
    int error, seq, type;
} vec_error_t;

typedef struct {
    char id[64];
    char desc[256];
    int is_encode;

    /* kind == encode */
    vec_frame_t frame;
    char expect_hex[VEC_HEX_MAX];

    /* kind == feed */
    int write_count;
    char writes[VEC_MAX_WRITES][VEC_HEX_MAX];
    int expect_frame_count;
    vec_frame_t expect_frames[VEC_MAX_FRAMES];
    int expect_error_count;
    vec_error_t expect_errors[VEC_MAX_ERRORS];
    char expect_remainders[VEC_MAX_WRITES][VEC_HEX_MAX];
    int has_expect_ack_generated;
    int expect_ack_generated;
} vec_case_t;

typedef struct {
    int count;
    vec_case_t *cases; /* calloc，vectors_free 释放 */
} vec_doc_t;

/* 0 成功；非 0 失败（消息打到 stderr） */
int vectors_load(const char *path, vec_doc_t *out);
void vectors_free(vec_doc_t *doc);

#endif /* BLE_LIGHT_TEST_VECTORS_JSON_H */