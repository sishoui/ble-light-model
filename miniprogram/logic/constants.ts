/**
 * 业务常量（spec §1.1 纯 TS，无 wx / Page / Component / getApp 引用）。
 *
 * 受限态阈值与固件 `firmware/core/gatt.h`（GATT_BRIGHTNESS_LIMIT /
 * GATT_POWER_LIMIT_MA / GATT_POWER_LIMIT_MAX_MA）对齐；灯路数与
 * strip_mask 8 位对齐。收拢在此单一导出，fake_device / business_service /
 * pages 统一引用，避免 127 / 15000 / 30000 等字面量散落各处。
 */

/** 受限态亮度上限（> 此值需满功率解锁，与固件 GATT_BRIGHTNESS_LIMIT 对齐）。 */
export const BRIGHTNESS_LIMIT = 127;

/** 受限态限流上限（mA，> 此值需满功率解锁）。 */
export const POWER_LIMIT_MA = 15000;

/** 硬件限流上限（mA，超过恒 NAK 0x05 非法参数）。 */
export const POWER_LIMIT_MAX_MA = 30000;

/** 灯路数（strip_mask 8 位，与固件 EFFECT_STRIP_COUNT 对齐）。 */
export const STRIP_COUNT = 8;

/** 全路掩码（0xFF = 全部 8 路）。 */
export const STRIP_MASK_ALL = 0xff;