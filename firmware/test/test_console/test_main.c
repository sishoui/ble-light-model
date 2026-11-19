/*
 * 串口测试指令解析单测（native / Unity）。
 *
 * 断言基准：console.h 文件头的语法定义（SET/BRI/SELFTEST/?，mask 与
 * effect/params 十六进制、亮度十进制）；参数期望长度复用 ble_proto
 * 长度表（灯效 0x01=3、0x02=7、0x00=0），语义校验不在解析器。
 */

#include <string.h>

#include <unity.h>

#include "console.h"

void setUp(void)
{
}

void tearDown(void)
{
}

static console_action_t parse(const char *line)
{
    console_action_t act;
    console_parse_line(line, strlen(line), &act);
    return act;
}

/* ---------- 空行 / 未知指令 ---------- */

static void test_empty_line_is_none(void)
{
    console_action_t act = parse("");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_NONE, act.type);
}

static void test_whitespace_only_is_none(void)
{
    console_action_t act = parse("   \t  ");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_NONE, act.type);
}

static void test_unknown_command_is_error(void)
{
    console_action_t act = parse("FOO 1 2 3");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_UNKNOWN_CMD, act.error_code);
}

/* ---------- SET ---------- */

static void test_set_static_all_strips_red(void)
{
    /* 静态红：effect 0x01，参数 R=ff G=00 B=00。 */
    console_action_t act = parse("SET ff 01 ff 00 00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0xFF, act.strip_mask);
    TEST_ASSERT_EQUAL_UINT8(0x01, act.effect_id);
    TEST_ASSERT_EQUAL_UINT8(3, act.param_len);
    TEST_ASSERT_EQUAL_UINT8(0xFF, act.params[0]);
    TEST_ASSERT_EQUAL_UINT8(0x00, act.params[1]);
    TEST_ASSERT_EQUAL_UINT8(0x00, act.params[2]);
}

static void test_set_single_strip_mask(void)
{
    /* 呼吸（0x02）期望 7 参数：R,G,B, period(2), min, max。 */
    console_action_t act = parse("SET 04 02 20 10 00 40 00 40 00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0x04, act.strip_mask);
    TEST_ASSERT_EQUAL_UINT8(0x02, act.effect_id);
    TEST_ASSERT_EQUAL_UINT8(7, act.param_len);
}

static void test_set_off_needs_no_params(void)
{
    console_action_t act = parse("SET ff 00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0x00, act.effect_id);
    TEST_ASSERT_EQUAL_UINT8(0, act.param_len);
}

static void test_set_params_short_is_error(void)
{
    /* 静态要 3 个参数，只给 2 个。 */
    console_action_t act = parse("SET ff 01 ff 00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_PARAMS_SHORT, act.error_code);
}

static void test_set_params_overlong_ignored(void)
{
    /* 静态期望 3，多给 2 个：接受（param_len=5，与协议 param_len 过长
     * 接受、多余忽略同口径 —— 语义层 effect_apply 忽略多余）。 */
    console_action_t act = parse("SET 01 01 0a 0b 0c 0d 0e");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(5, act.param_len);
    TEST_ASSERT_EQUAL_UINT8(0x0A, act.params[0]);
    TEST_ASSERT_EQUAL_UINT8(0x0E, act.params[4]);
}

static void test_set_bad_mask_is_error(void)
{
    console_action_t act = parse("SET xx 01 ff 00 00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_BAD_ARG, act.error_code);
}

static void test_set_missing_effect_is_error(void)
{
    console_action_t act = parse("SET ff");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_BAD_ARG, act.error_code);
}

static void test_set_unknown_effect_passes_to_app(void)
{
    /* 未知灯效不拦（app 层 effect_apply 报 0x03），param_len=0。 */
    console_action_t act = parse("SET ff 7f");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0x7F, act.effect_id);
}

static void test_set_params_long_capped(void)
{
    /* 参数超过缓冲（>10）：解析不报错，超量丢弃（SET_EFFECT 类接受）。 */
    console_action_t act = parse("SET ff 03 "
                                 "01 02 03 04 05 06 07 08 09 0a 0b 0c");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    /* 渐变期望 10；前 10 个进缓冲。 */
    TEST_ASSERT_EQUAL_UINT8(10, act.param_len);
}

/* ---------- BRI ---------- */

static void test_bri_decimal(void)
{
    console_action_t act = parse("BRI 128");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_BRIGHTNESS, act.type);
    TEST_ASSERT_EQUAL_UINT8(128, act.brightness);
}

static void test_bri_zero(void)
{
    console_action_t act = parse("BRI 0");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_BRIGHTNESS, act.type);
    TEST_ASSERT_EQUAL_UINT8(0, act.brightness);
}

static void test_bri_255(void)
{
    console_action_t act = parse("BRI 255");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_BRIGHTNESS, act.type);
    TEST_ASSERT_EQUAL_UINT8(255, act.brightness);
}

static void test_bri_256_is_range_error(void)
{
    console_action_t act = parse("BRI 256");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_BRIGHTNESS_RANGE, act.error_code);
}

static void test_bri_negative_is_range_error(void)
{
    console_action_t act = parse("BRI -1");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_BRIGHTNESS_RANGE, act.error_code);
}

static void test_bri_missing_arg(void)
{
    console_action_t act = parse("BRI");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_ERROR, act.type);
    TEST_ASSERT_EQUAL_UINT8(CONSOLE_ERR_BRIGHTNESS_RANGE, act.error_code);
}

/* ---------- SELFTEST / ? ---------- */

static void test_selftest(void)
{
    console_action_t act = parse("SELFTEST");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SELFTEST, act.type);
}

static void test_help(void)
{
    console_action_t act = parse("?");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_HELP, act.type);
}

/* ---------- 容错 ---------- */

static void test_leading_trailing_whitespace_ok(void)
{
    console_action_t act = parse("  SET 01 01 01 02 03  ");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(3, act.param_len);
}

static void test_lower_case_hex(void)
{
    console_action_t act = parse("set ff 01 aa bb cc");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0xAA, act.params[0]);
    TEST_ASSERT_EQUAL_UINT8(0xCC, act.params[2]);
}

static void test_0x_prefix_hex(void)
{
    console_action_t act = parse("SET 0xff 0x01 0xff 0x00 0x00");

    TEST_ASSERT_EQUAL_INT(CONSOLE_ACT_SET_EFFECT, act.type);
    TEST_ASSERT_EQUAL_UINT8(0xFF, act.strip_mask);
    TEST_ASSERT_EQUAL_UINT8(3, act.param_len);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_empty_line_is_none);
    RUN_TEST(test_whitespace_only_is_none);
    RUN_TEST(test_unknown_command_is_error);
    RUN_TEST(test_set_static_all_strips_red);
    RUN_TEST(test_set_single_strip_mask);
    RUN_TEST(test_set_off_needs_no_params);
    RUN_TEST(test_set_params_short_is_error);
    RUN_TEST(test_set_params_overlong_ignored);
    RUN_TEST(test_set_bad_mask_is_error);
    RUN_TEST(test_set_missing_effect_is_error);
    RUN_TEST(test_set_unknown_effect_passes_to_app);
    RUN_TEST(test_set_params_long_capped);
    RUN_TEST(test_bri_decimal);
    RUN_TEST(test_bri_zero);
    RUN_TEST(test_bri_255);
    RUN_TEST(test_bri_256_is_range_error);
    RUN_TEST(test_bri_negative_is_range_error);
    RUN_TEST(test_bri_missing_arg);
    RUN_TEST(test_selftest);
    RUN_TEST(test_help);
    RUN_TEST(test_leading_trailing_whitespace_ok);
    RUN_TEST(test_lower_case_hex);
    RUN_TEST(test_0x_prefix_hex);
    return UNITY_END();
}