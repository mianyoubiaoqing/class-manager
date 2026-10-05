# Vue Router 4 路由导航与生命周期最佳实践 (vue-router-best-practices)

Vue Router 4 面向现代 Vue 3 SPA 应用的核心路由实践。

---

## 1. 导航守卫 (Navigation Guards) 规范

- **废弃 `next()` 回调**：Vue Router 4 推荐使用返回 `boolean` 或路由位置对象的现代写法，严禁混用 `next()` 导致重复跳转或无限递归；

```typescript
router.beforeEach(async (to, from) => {
  const authStore = useAuthStore();

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    // 重定向至登录页
    return { name: 'Login', query: { redirect: to.fullPath } };
  }

  // 正常放行
  return true;
});
```

---

## 2. 路由参数变化时的组件复用陷阱

当在同路由间切换参数（如 `/class/1` -> `/class/2`）时，由于组件实例被复用，`onMounted` 不会重新执行。

```typescript
import { watch } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

// 必须通过 watch 路由参数来重新拉取数据
watch(
  () => route.params.classId,
  (newId) => {
    if (newId) fetchClassData(String(newId));
  },
  { immediate: true },
);
```
