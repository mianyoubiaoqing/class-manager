# Vue JSX 最佳实践与与 React JSX 核心差异 (vue-jsx-best-practices)

Vue 3 原生支持 JSX / TSX 语法，但与 React JSX 存在核心语法和运行机制差异。

---

## 核心差异速查表

| 语法特性         | React JSX                    | Vue 3 JSX (@vitejs/plugin-vue-jsx)                                       |
| :--------------- | :--------------------------- | :----------------------------------------------------------------------- |
| **CSS 类名**     | `className="card"`           | `class="card"`（支持数组/对象语法 `class={['card', { active: true }]}`） |
| **双向绑定**     | `value={val} onChange={...}` | `v-model={val.value}`                                                    |
| **插槽 (Slots)** | `children` 或自定义 props    | 作用域插槽对象 `v-slots={{ default: () => <p/>, header: () => <h1/> }}`  |
| **事件监听**     | `onClick={handleClick}`      | `onClick={handleClick}` 或 `onUpdate:modelValue`                         |
| **条件渲染**     | `{cond ? <A /> : <B />}`     | 原生三元表达式 `{cond ? <A /> : <B />}` 或配合 `v-show` 指令             |
| **指令支持**     | 无内置指令                   | 支持 `v-show={isVisible}`，不支持 `v-for`/`v-if`（推荐用 map/三元）      |
