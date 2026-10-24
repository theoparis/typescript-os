#include "ts2c_runtime.h"

#if defined(TS2C_HOSTED)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#else
#ifndef TS2C_HEAP_SIZE
#define TS2C_HEAP_SIZE (1024u * 1024u)
#endif
static unsigned char ts2c_heap[TS2C_HEAP_SIZE];
static size_t ts2c_heap_used;
#endif

static size_t ts2c_align16(size_t n) {
  return (n + 15u) & ~(size_t)15u;
}

void *ts2c_alloc(size_t size) {
#if defined(TS2C_HOSTED)
  void *p = calloc(1, size);
  if (p == NULL) ts2c_panic("ts2c_alloc: out of memory");
  return p;
#else
  size_t aligned = ts2c_align16(size);
  if (ts2c_heap_used + aligned > TS2C_HEAP_SIZE)
    ts2c_panic("ts2c_alloc: out of memory");
  void *p = &ts2c_heap[ts2c_heap_used];
  ts2c_heap_used += aligned;
  return p;
#endif
}

void ts2c_panic(const char *message) {
#if defined(TS2C_HOSTED)
  fputs("ts2c panic: ", stderr);
  fputs(message, stderr);
  fputc('\n', stderr);
  abort();
#else
  (void)message;
  for (;;) {
  }
#endif
}

bool ts2c_is_instance(const Ts2cClass *actual, const Ts2cClass *target) {
  for (const Ts2cClass *c = actual; c != NULL; c = c->parent) {
    if (c == target) return true;
  }
  return false;
}

static size_t ts2c_str_len_raw(const char *s) {
  size_t n = 0;
  while (s[n] != 0) n++;
  return n;
}

int64_t ts2c_str_len(const char *s) {
  return (int64_t)ts2c_str_len_raw(s);
}

char *ts2c_str_concat(const char *a, const char *b) {
  size_t na = ts2c_str_len_raw(a);
  size_t nb = ts2c_str_len_raw(b);
  char *out = (char *)ts2c_alloc(na + nb + 1);
  for (size_t i = 0; i < na; i++) out[i] = a[i];
  for (size_t i = 0; i < nb; i++) out[na + i] = b[i];
  out[na + nb] = 0;
  return out;
}

bool ts2c_str_eq(const char *a, const char *b) {
  if (a == b) return true;
  if (a == NULL || b == NULL) return false;
  while (*a != 0 && *a == *b) {
    a++;
    b++;
  }
  return *a == *b;
}

void ts2c_log_i64(int64_t value) {
#if defined(TS2C_HOSTED)
  printf("%lld\n", (long long)value);
#else
  (void)value;
#endif
}

void ts2c_log_f64(double value) {
#if defined(TS2C_HOSTED)
  printf("%g\n", value);
#else
  (void)value;
#endif
}

void ts2c_log_hex(uint64_t value) {
#if defined(TS2C_HOSTED)
  printf("0x%llx\n", (unsigned long long)value);
#else
  (void)value;
#endif
}

void ts2c_putchar(int c) {
#if defined(TS2C_HOSTED)
  putchar(c);
  fflush(stdout);
#else
  (void)c;
#endif
}

int ts2c_getchar(void) {
#if defined(TS2C_HOSTED)
  return getchar();
#else
  return -1;
#endif
}

void ts2c_log_str(const char *value) {
#if defined(TS2C_HOSTED)
  printf("%s\n", value);
#else
  (void)value;
#endif
}
