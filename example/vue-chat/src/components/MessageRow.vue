<script setup lang="ts">
import type { Message } from '../schema.ts';

defineProps<{
  message: Message;
  isOwn: boolean;
}>();

function formatTime(value: Date): string {
  return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <li :class="isOwn ? 'message own' : 'message'">
    <span class="author">{{ isOwn ? 'You' : message.user_name }}</span>
    <span class="text">{{ message.message }}</span>
    <time class="time">{{ formatTime(message.created_at) }}</time>
  </li>
</template>
