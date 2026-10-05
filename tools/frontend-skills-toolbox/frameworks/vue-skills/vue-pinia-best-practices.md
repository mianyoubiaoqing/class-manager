# Pinia 现代状态管理最佳实践 (vue-pinia-best-practices)

Pinia 是 Vue 3 官方推荐的状态管理库，轻量、原生支持 TypeScript，且无 Vuex 的繁琐 mutations。

---

## 1. 结构与定义标准 (Setup Store 范式)

推荐使用现代的 Setup Store 风格定义：

```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useRosterStore = defineStore('roster', () => {
  // State
  const students = ref<Array<{ id: string; name: string }>>([]);
  const activeClassId = ref<string>('');

  // Getters
  const studentCount = computed(() => students.value.length);

  // Actions
  async function loadStudents(classId: string) {
    activeClassId.value = classId;
    const res = await api.getStudents(classId);
    students.value = res.data;
  }

  function reset() {
    students.value = [];
    activeClassId.value = '';
  }

  return {
    students,
    activeClassId,
    studentCount,
    loadStudents,
    reset,
  };
});
```

---

## 2. 避免解构破坏响应式 (storeToRefs)

```typescript
import { useRosterStore } from '@/stores/roster';
import { storeToRefs } from 'pinia';

const store = useRosterStore();

// ❌ 错误做法：直接解构会丢掉响应式
// const { students, studentCount } = store;

// ✅ 正确做法：使用 storeToRefs 解构 state 与 getters；方法直接解构
const { students, studentCount } = storeToRefs(store);
const { loadStudents, reset } = store;
```
