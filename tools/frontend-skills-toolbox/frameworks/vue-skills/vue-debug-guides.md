# Vue 3 调试与运行时报错排查指南 (vue-debug-guides)

本指南针对 Vue 3 常见运行时错误、响应式丢失、异步生命周期问题及性能回退提供快速排查与修复方案。

---

## 1. 响应式与 Ref 陷阱 (Reactivity & Ref Gotchas)

### ❌ 陷阱 1：解构失去响应式 (Destructuring loses reactivity)

```typescript
// 错误写法：失去响应式连接
const { count, user } = state;

// 正确方案 A：使用 toRefs
import { toRefs } from 'vue';
const { count, user } = toRefs(state);

// 正确方案 B：保持对象引用访问
console.log(state.count);
```

### ❌ 陷阱 2：忘记 `.value` 访问

- 在 `<script setup>` 中，访问 `ref`、`computed`、`shallowRef` 必须通过 `.value`；
- 模板中自动解包，绝不在模板内写 `myRef.value`。

### ❌ 陷阱 3：第三方非响应式对象被 Proxy 劫持导致崩溃

```typescript
// 错误写法：将富文本、Three.js、Monaco 实例等复杂对象放入 reactive() 会破坏内部 this
const editor = reactive(new HeavyLibrary());

// 正确方案：使用 markRaw 或 shallowRef
import { markRaw, shallowRef } from 'vue';
const editor = shallowRef(markRaw(new HeavyLibrary()));
```

---

## 2. 计算属性 (Computed) 常见误区

- **禁止在 Computed Getter 中产生副作用**：计算属性必须是纯函数，严禁在 getter 中发起异步请求、修改其他 state 或修改原数组（如 `arr.sort()` 会修改原数组，应使用 `[...arr].sort()`）。
- **只读保护**：计算属性返回值默认是只读的，若需双向绑定，使用具备 `get` 与 `set` 的可写计算属性。

---

## 3. 异步生命周期与 Setup 上下文

### ❌ 陷阱：在 `await` 之后注册生命周期钩子

```typescript
<script setup>
// 错误写法：await 之后组件实例上下文丢失，onMounted 永远不会触发！
await fetchUserData();
onMounted(() => { /* 永远不执行 */ });

// 正确方案：同步注册生命周期钩子
onMounted(() => { /* 正常执行 */ });
await fetchUserData();
</script>
```

---

## 4. 列表渲染 (v-for) 与 Key 属性

- **严禁用数组索引充当 `key` 进行具有输入状态或删除动作的列表渲染**；
- 必须使用业务主键 `key="student.id"`，避免 DOM 节点复用导致表单状态错位。
