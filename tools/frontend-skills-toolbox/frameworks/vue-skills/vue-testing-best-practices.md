# Vue 3 测试最佳实践 (vue-testing-best-practices)

结合 Vitest + Vue Test Utils + Playwright 的全链路测试体系。

---

## 1. 单元与组件测试 (Vitest + Vue Test Utils)

### 黑盒交互测试原则 (Blackbox Approach)

测试用例应关注用户可见的行为和输出，而非组件内部私有变量或实现细节：

```typescript
import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import StudentCard from './StudentCard.vue';

describe('StudentCard.vue', () => {
  it('点击选中按钮时正确触发 select 事件并更新 UI', async () => {
    const wrapper = mount(StudentCard, {
      props: {
        student: { id: 's-1', name: '陈子涵', studentNumber: '20260101' },
      },
    });

    expect(wrapper.text()).toContain('陈子涵');

    const button = wrapper.find('button[aria-label="选择学生"]');
    await button.trigger('click');

    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('select')![0]).toEqual(['s-1']);
  });
});
```

---

## 2. 异步状态与 DOM 刷新 (flushPromises)

处理包含 `async` 数据获取的组件测试时，必须使用 `flushPromises()` 等待全部微任务排空：

```typescript
import { flushPromises, mount } from '@vue/test-utils';

it('加载远程学生名册并展示', async () => {
  const wrapper = mount(RosterPage);
  await flushPromises(); // 等待 API 请求与 nextTick 渲染完成
  expect(wrapper.findAll('.student-row')).toHaveLength(42);
});
```
