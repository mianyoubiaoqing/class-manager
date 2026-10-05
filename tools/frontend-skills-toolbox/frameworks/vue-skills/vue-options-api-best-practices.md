# Vue 3 Options API 最佳实践 (vue-options-api-best-practices)

面向存量 Vue 3 项目或偏好 Options API（`data()`, `methods`, `computed`, `this`）的规范指南。

---

## 1. `this` 绑定与箭头函数禁忌

- **严禁在 `methods` 或生命周期钩子中使用箭头函数**：箭头函数会捕获上层词法作用域的 `this`，导致 `this.myState` 变成 `undefined`；

```typescript
// 错误写法
methods: {
  fetchData: () => {
    console.log(this.user); // undefined!
  }
}

// 正确写法
methods: {
  fetchData() {
    console.log(this.user); // 正常访问实例
  }
}
```

---

## 2. TypeScript 严格类型推断 (defineComponent)

在 Options API 中使用 TypeScript 时，必须使用 `defineComponent` 包裹，以获得完整的属性与类型推断：

```typescript
import { defineComponent, type PropType } from 'vue';

interface Student {
  id: string;
  name: string;
}

export default defineComponent({
  props: {
    student: {
      type: Object as PropType<Student>,
      required: true,
    },
  },
  data() {
    return {
      selected: false,
    };
  },
  computed: {
    displayTitle(): string {
      return `${this.student.name} (${this.selected ? '已选' : '未选'})`;
    },
  },
});
```
