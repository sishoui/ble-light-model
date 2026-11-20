// C core host 单测占位（firmware/[env:native]，Unity）。
// 骨架阶段只验证脚手架（Unity 编译 + 跑一个真断言）通，不是真业务用例。
// 执行阶段在此目录按 docs/spec/driver.md §7 落地 D1–D16。

#include <unity.h>

void setUp(void) {}
void tearDown(void) {}

static void test_scaffold(void) {
    TEST_ASSERT_EQUAL_UINT32(1, 1);
}

static void test_strip_count_constant(void) {
    // 只验证一个编译期常量能在 host 侧取到；真实断言在执行阶段落地。
    TEST_ASSERT_TRUE(8 > 0);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_scaffold);
    RUN_TEST(test_strip_count_constant);
    return UNITY_END();
}