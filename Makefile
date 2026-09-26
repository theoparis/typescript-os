TARGET_TRIPLE ?= aarch64-unknown-none-elf

TSLANG ?= tslang
ifeq ($(origin CC),default)
CC := clang
endif
QEMU ?= qemu-system-aarch64

PAGE_SIZE ?= 4k
PAGE_SIZE_LOWER := $(shell echo $(PAGE_SIZE) | tr '[:upper:]' '[:lower:]')

ifeq ($(PAGE_SIZE_LOWER),16k)
CONFIG_PAGE_SIZE_16K := true
QEMU_CPU ?= cortex-a76
else ifeq ($(PAGE_SIZE_LOWER),4k)
CONFIG_PAGE_SIZE_16K := false
QEMU_CPU ?= cortex-a53
else
$(error Invalid PAGE_SIZE '$(PAGE_SIZE)'. Supported values: 4k, 16k)
endif

BUILD_DIR ?= build
TARGET ?= $(BUILD_DIR)/boot/kernel.elf
LINKER_SCRIPT ?= linker.ld

TSFLAGS ?= --mtriple=$(TARGET_TRIPLE) --mm=rc --emit=obj
ASFLAGS ?= --target=$(TARGET_TRIPLE)
LDFLAGS ?= -fuse-ld=lld -nostdlib -T$(LINKER_SCRIPT) --target=$(TARGET_TRIPLE)
QEMUFLAGS ?= -M virt -cpu $(QEMU_CPU) -nographic

OBJS := \
	$(BUILD_DIR)/boot.o \
	$(BUILD_DIR)/vectors.o \
	$(BUILD_DIR)/config.o \
	$(BUILD_DIR)/uart.o \
	$(BUILD_DIR)/exceptions.o \
	$(BUILD_DIR)/mmu.o \
	$(BUILD_DIR)/kmain.o

CONFIG_TS := $(BUILD_DIR)/config.ts

export PATH := $(HOME)/src/TypeScriptCompiler/build/bin:$(PATH)

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(OBJS) $(LINKER_SCRIPT) | $(BUILD_DIR)/boot
	$(CC) $(LDFLAGS) $(OBJS) -o $@

$(CONFIG_TS): FORCE | $(BUILD_DIR)
	@echo "// Auto-generated configuration" > $@.tmp; \
	echo "export const CONFIG_USE_16K: boolean = $(CONFIG_PAGE_SIZE_16K);" >> $@.tmp; \
	if ! cmp -s $@.tmp $@ 2>/dev/null; then \
		mv $@.tmp $@; \
	else \
		rm -f $@.tmp; \
	fi

$(BUILD_DIR)/config.o: $(CONFIG_TS) | $(BUILD_DIR)
	$(TSLANG) $(TSFLAGS) -o $@ $<

$(BUILD_DIR)/%.o: %.ts | $(BUILD_DIR)
	$(TSLANG) $(TSFLAGS) -o $@ $<

$(BUILD_DIR)/%.o: %.s | $(BUILD_DIR)
	$(CC) $(ASFLAGS) -c $< -o $@

$(BUILD_DIR) $(BUILD_DIR)/boot:
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR)

run: $(TARGET)
	$(QEMU) $(QEMUFLAGS) -kernel $(TARGET)

FORCE:
.PHONY: FORCE
