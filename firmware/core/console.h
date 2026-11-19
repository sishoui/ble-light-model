#ifndef BLE_LIGHT_CONSOLE_H
#define BLE_LIGHT_CONSOLE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 串口测试指令解析（纯 C99，纯函数，不依赖 IDF，不用动态内存）。
 *
 * 行式 ASCII 指令（USB CDC 或 UART，仅测试用，不进 BLE 协议 profile
 * —— #4 决议）。行以 '\n' 或 '\r' 结束，最长 BLE_LIGHT_CONSOLE_LINE_MAX
 * 字节，超长行整行丢弃（错误码 LINE_TOO_LONG）。指令与参数以空白分隔，
 * 参数为十进制（亮度）或十六进制（mask / effect_id / params 的每个
 * 字节，带或不带 0x 前缀均可）。
 *
 * 指令集：
 *   SET <mask> <effect_id> [p0 p1 ... pn]   设置 mask 选中灯带的灯效
 *                                            mask：两位十六进制（0xFF=全部）
 *                                            effect_id / 参数：十六进制字节
 *                                            参数个数由 effect_id 决定
 *                                            （ble_proto 长度表），少了
 *                                            报 PARAMS_SHORT，多了忽略
 *   BRI <0..255>                            全局亮度（十进制）
 *   SELFTEST                                触发上电自检序列
 *   ?                                       打印帮助（由 app 层应答）
 *
 * 解析器只产出动作结构（console_action_t），不执行 —— 执行（effect_apply
 * / 亮度 / 自检）在 app 层，保持 core 无副作用。
 */

#define BLE_LIGHT_CONSOLE_LINE_MAX 64u
/* SET 的参数上限：effect_id(1) + 最长效果参数(10) + mask/指令字段余量。 */
#define BLE_LIGHT_CONSOLE_MAX_PARAMS 10u

/* 解析出的动作类型。 */
typedef enum {
    CONSOLE_ACT_NONE = 0,   /* 空行 / 纯空白：无动作 */
    CONSOLE_ACT_SET_EFFECT,
    CONSOLE_ACT_SET_BRIGHTNESS,
    CONSOLE_ACT_SELFTEST,
    CONSOLE_ACT_HELP,
    CONSOLE_ACT_ERROR,
} console_action_type_t;

/* 错误码（CONSOLE_ACT_ERROR 的 code 字段）。 */
#define CONSOLE_ERR_UNKNOWN_CMD 0x01u
#define CONSOLE_ERR_BAD_ARG 0x02u
#define CONSOLE_ERR_PARAMS_SHORT 0x03u
#define CONSOLE_ERR_PARAMS_LONG 0x04u
#define CONSOLE_ERR_BRIGHTNESS_RANGE 0x05u
#define CONSOLE_ERR_LINE_TOO_LONG 0x06u

typedef struct {
    console_action_type_t type;
    uint8_t error_code;      /* type==ERROR 时有意义 */
    /* SET_EFFECT： */
    uint8_t strip_mask;      /* 0xFF = 全部 */
    uint8_t effect_id;
    uint8_t param_len;
    uint8_t params[BLE_LIGHT_CONSOLE_MAX_PARAMS];
    /* SET_BRIGHTNESS： */
    uint8_t brightness;
} console_action_t;

/*
 * 喂入一行（不含结尾换行；可含首尾空白）。
 * line 不必 NUL 结尾，用 len。解析结果写入 *out（调用方提供）。
 * 空行返回 CONSOLE_ACT_NONE。
 */
void console_parse_line(const char *line, size_t len, console_action_t *out);

#ifdef __cplusplus
}
#endif

#endif /* BLE_LIGHT_CONSOLE_H */