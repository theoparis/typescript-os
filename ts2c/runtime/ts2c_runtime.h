#ifndef TS2C_RUNTIME_H
#define TS2C_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct Ts2cClass {
  const struct Ts2cClass *parent;
  const char *name;
} Ts2cClass;

void *ts2c_alloc(size_t size);
void ts2c_panic(const char *message);
bool ts2c_is_instance(const Ts2cClass *actual, const Ts2cClass *target);

char *ts2c_str_concat(const char *a, const char *b);
bool ts2c_str_eq(const char *a, const char *b);
int64_t ts2c_str_len(const char *s);

void ts2c_log_i64(int64_t value);
void ts2c_log_f64(double value);
void ts2c_log_str(const char *value);
void ts2c_log_hex(uint64_t value);
void ts2c_putchar(int c);
int ts2c_getchar(void);

#endif
