#include <unity.h>

#include "crc16.h"

void setUp(void)
{
}

void tearDown(void)
{
}

static void test_crc16_ccitt_false_standard_check_value(void)
{
    /* CRC-16/CCITT-FALSE 的标准检查输入是 ASCII "123456789"。 */
    static const uint8_t check[] = {
        0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    };

    TEST_ASSERT_EQUAL_UINT16(0x29B1, crc16_ccitt_false(check, sizeof(check)));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_crc16_ccitt_false_standard_check_value);
    return UNITY_END();
}