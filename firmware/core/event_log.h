#ifndef BLE_LIGHT_EVENT_LOG_H
#define BLE_LIGHT_EVENT_LOG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * PC 集成测试事件日志（JSONL）核心（纯 C99，host 单测，无 IDF 依赖）。
 *
 * spec §3.3 断言锚点：C3 经 USB CDC 输出事件级 JSONL 行，PC 侧（bleak notify
 * 时间线）与之交叉断言。每行形如：
 *   {"t_ms":12345,"seq":7,"ev":"rx","type":2,"flags":1,"len":4}
 * 字段口径：
 * - t_ms：C3 单调毫秒时钟（esp_timer），仅供 PC 侧排序串口日志，不作跨机
 *   断言基准（跨机时序断言用 PC 单调时钟，见 spec §3.3）。
 * - seq：关联键 —— RX 帧序号回显；无关联帧的事件为 0。
 * - ev：事件种类（boot/gap/rx/ack/nak/status/nvs/drop/glitch）。
 * - 其余为事件特有字段。
 *
 * 职责：JSON 行格式化（字符串转义）+ 定长环形缓冲（无动态内存）。USB CDC
 * 写出在 ports 层（ports/esp32/event_log.c）；本层全部为纯函数。
 *
 * 事件种类（ports 层 event_log_emit_* 系列产生）：
 * - boot   {fw}                                上电装配完成
 * - gap    {what, ...}                         连接/断连/订阅/MTU 事件
 * - rx     {type, flags, len}                  CMD 帧解出（seq = 帧序号）
 * - ack    {}                                   ACK notify 发出（seq 回显）
 * - nak    {err}                                NAK notify 发出（seq 回显）
 * - status {brightness, glitch, drop}           STATUS 帧发出
 * - nvs    {op, rc}                             NVS 保存结果
 * - drop   {reason, err?}                       协议层丢帧（feed 溢出/错误帧）
 * - glitch {count}                              调度 glitch 累计值变化
 */

/* 单行最大字节数（含结尾 '\n'；writer 容量 = 本值，最长内容 159 字节）。 */
#define BLE_LIGHT_EVENT_LOG_LINE_MAX 160u
/* 环形缓冲行数（定长；满则丢最旧行并计数）。 */
#define BLE_LIGHT_EVENT_LOG_RING_LINES 8u

/* ---- JSON 行格式化（写入调用方提供的定长缓冲） ---- */

typedef struct {
    char *buf;
    size_t cap;   /* 缓冲容量（含 NUL 余量） */
    size_t len;   /* 已写入长度（不含 NUL） */
    int overflow; /* 容量不足：后续追加被丢弃，整行作废（调用方弃行） */
} event_log_writer_t;

void event_log_writer_init(event_log_writer_t *w, char *buf, size_t cap);

/* 开始一个对象：{"t_ms":<t>,"seq":<seq>,"ev":"<ev>"（不含右花括号）。 */
void event_log_writer_begin(event_log_writer_t *w, uint32_t t_ms,
                            uint16_t seq, const char *ev);

/* 追加 ,<key>:<v>（整数，十进制）。 */
void event_log_writer_int(event_log_writer_t *w, const char *key, long v);

/* 追加 ,<key>:"<v>"：JSON 字符串转义 —— " \ 与 \b \f \n \r \t 用短转义，
 * 其余 < 0x20 的控制字符用 ASCII  \u00XX；'/' 不转义（JSON 合法）。 */
void event_log_writer_str(event_log_writer_t *w, const char *key,
                          const char *v);

/* 收尾：} + '\n'。overflow 置位时输出不完整 —— 调用方弃行。 */
void event_log_writer_end(event_log_writer_t *w);

/* ---- 定长环形缓冲（行含 '\n'；lens 不含 NUL） ---- */

typedef struct {
    char lines[BLE_LIGHT_EVENT_LOG_RING_LINES][BLE_LIGHT_EVENT_LOG_LINE_MAX];
    uint16_t lens[BLE_LIGHT_EVENT_LOG_RING_LINES];
    uint8_t head;      /* 下一写入行 */
    uint8_t tail;      /* 最旧行 */
    uint8_t count;     /* 当前行数 */
    uint32_t dropped;  /* 因环满被丢弃的最旧行数 */
    uint32_t rejected; /* 因空行/超长/溢出被拒的行数 */
} event_log_ring_t;

void event_log_ring_init(event_log_ring_t *r);

/* 推入一行（含 '\n'，len 含 '\n'）。0 = 入环；-1 = 空行或 len >= LINE_MAX。 */
int event_log_ring_push(event_log_ring_t *r, const char *line, size_t len);

/* 弹出最旧一行到 out（NUL 结尾）；空环返回 0。out_cap 需 >= LINE_MAX。 */
size_t event_log_ring_pop(event_log_ring_t *r, char *out, size_t out_cap);

/* 把 writer 内容推入环；writer.overflow 时整行丢弃（rejected++）。 */
int event_log_ring_push_writer(event_log_ring_t *r,
                               const event_log_writer_t *w);

uint32_t event_log_ring_dropped(const event_log_ring_t *r);
uint32_t event_log_ring_rejected(const event_log_ring_t *r);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_EVENT_LOG_H */