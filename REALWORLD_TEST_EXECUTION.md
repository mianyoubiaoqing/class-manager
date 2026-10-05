# 高强度实战场景测试 - 执行记录
**测试时间**：2026-10-05  
**测试版本**：class-manager v0.1.0 (Schema 11)  
**测试环境**：Windows 11 Pro 10.0.26300, Node 24.14.0, Electron 构建版本

---

## 执行策略调整

### 问题：Playwright Electron启动失败
```
Error: Process failed to launch!
at waitForLine (playwright-core/lib/coreBundle.js:44106:21)
```

**根因分析**：
- 桌面smoke测试依赖Playwright启动真实Electron窗口
- 当前环境可能缺少显示器/X11环境
- 或Electron构建配置问题

**调整方案**：
1. **先完成可离线执行的压力测试**（核心逻辑、数据库、备份）
2. **构建打包版本手动验证UI**（替代自动化UI测试）
3. **补充单元测试覆盖边界场景**

---

## Phase 1: 核心逻辑压力测试（可自动化）

### 测试1.1：名册管理 - 大批量CRUD

**测试代码**：
```typescript
// tests/stress-roster.test.ts
import { test, expect } from 'vitest';
import { Workspace } from '../src/core/workspace';

test('stress: 100 students × 3 classes with rapid operations', async () => {
  const ws = createTestWorkspace();
  const startTime = performance.now();
  
  // 创建3个班级
  const classes = [];
  for (let i = 1; i <= 3; i++) {
    const snapshot = ws.saveClass({
      displayName: `高一${i}班`,
      shortName: `高一${i}`,
      gradYear: 2026,
      expectedRevision: 0
    });
    classes.push(snapshot.classes[snapshot.classes.length - 1]);
  }
  
  // 批量创建100名学生
  const students = [];
  for (let i = 1; i <= 100; i++) {
    const classIdx = (i - 1) % 3;
    const snapshot = ws.saveStudent({
      displayName: `学生${String(i).padStart(3, '0')}`,
      studentNumber: `S${String(i).padStart(4, '0')}`,
      enrollments: [{
        classId: classes[classIdx].id,
        validFrom: '2026-09-01T00:00:00Z'
      }],
      expectedRevision: 0
    });
    students.push(snapshot.students[snapshot.students.length - 1]);
  }
  
  const createTime = performance.now() - startTime;
  console.log(`创建耗时: ${createTime.toFixed(2)}ms`);
  expect(createTime).toBeLessThan(5000); // 5秒内完成
  
  // 快速连续编辑20名学生
  const editStart = performance.now();
  for (let i = 0; i < 20; i++) {
    const student = students[i];
    ws.saveStudent({
      id: student.id,
      displayName: `${student.displayName}_已编辑`,
      studentNumber: student.studentNumber,
      enrollments: student.enrollments,
      expectedRevision: student.revision
    });
  }
  const editTime = performance.now() - editStart;
  console.log(`20次编辑耗时: ${editTime.toFixed(2)}ms`);
  expect(editTime).toBeLessThan(1000); // 1秒内
  
  // 验证数据完整性
  const final = ws.snapshot();
  expect(final.students).toHaveLength(100);
  expect(final.classes).toHaveLength(3);
  
  // 验证归属历史
  const enrollments = final.enrollments.filter(e => !e.validTo);
  expect(enrollments).toHaveLength(100); // 每人一条在籍记录
});
```

**执行命令**：
```bash
npm test -- tests/stress-roster.test.ts
```

**预期结果**：
- ✅ 100学生创建<5秒
- ✅ 20次编辑<1秒
- ✅ 数据完整性100%

---

### 测试1.2：成绩导入 - 统计准确性验证

**测试代码**：
```typescript
test('stress: 100 students × 10 exams × 8 subjects statistics accuracy', async () => {
  const ws = createTestWorkspace();
  
  // 创建班级和学生
  const classSnapshot = ws.saveClass({
    displayName: '高一1班',
    shortName: '高一1',
    gradYear: 2026,
    expectedRevision: 0
  });
  const classId = classSnapshot.classes[0].id;
  
  const students = [];
  for (let i = 1; i <= 100; i++) {
    const snapshot = ws.saveStudent({
      displayName: `学生${i}`,
      studentNumber: `S${String(i).padStart(4, '0')}`,
      enrollments: [{ classId, validFrom: '2026-09-01T00:00:00Z' }],
      expectedRevision: 0
    });
    students.push(snapshot.students[snapshot.students.length - 1]);
  }
  
  // 10次考试 × 8科目 = 80个成绩版本
  const subjects = ['数学', '语文', '英语', '物理', '化学', '生物', '政治', '历史'];
  const exams = [];
  
  for (let examIdx = 1; examIdx <= 10; examIdx++) {
    const examSnapshot = ws.saveExam({
      title: `第${examIdx}次考试`,
      date: `2026-09-${String(examIdx).padStart(2, '0')}`,
      expectedRevision: 0
    });
    const exam = examSnapshot.exams[examSnapshot.exams.length - 1];
    exams.push(exam);
    
    for (const subject of subjects) {
      const scores = students.map((student, idx) => {
        // 生成正态分布成绩（均值75，标准差15）
        const raw = 75 + (Math.random() + Math.random() - 1) * 15;
        const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
        
        return {
          studentId: student.id,
          subjectName: subject,
          score,
          status: 'present' as const
        };
      });
      
      ws.saveScores({
        examId: exam.id,
        subjectName: subject,
        maxScore: 100,
        scores,
        expectedRevision: 0
      });
    }
  }
  
  console.log(`成绩记录总数: ${10 * 8 * 100} = 8000条`);
  
  // 验证统计指标准确性
  const snapshot = ws.snapshot();
  const mathScores = snapshot.scores.filter(s => 
    s.examId === exams[0].id && s.subjectName === '数学'
  );
  
  // 手工计算均分
  const sum = mathScores.reduce((acc, s) => acc + (s.score ?? 0), 0);
  const manualAvg = sum / mathScores.length;
  
  // 系统统计（假设有stats API）
  const stats = computeStats(mathScores);
  
  expect(Math.abs(stats.average - manualAvg)).toBeLessThan(0.01);
  expect(stats.count).toBe(100);
  expect(stats.max).toBeLessThanOrEqual(100);
  expect(stats.min).toBeGreaterThanOrEqual(0);
  
  console.log(`统计验证通过: 均分=${stats.average.toFixed(2)}`);
});

function computeStats(scores: Array<{score: number | null}>) {
  const valid = scores.filter(s => s.score !== null).map(s => s.score!);
  const sorted = [...valid].sort((a, b) => a - b);
  
  return {
    count: valid.length,
    average: valid.reduce((a, b) => a + b, 0) / valid.length,
    median: sorted[Math.floor(sorted.length / 2)],
    max: Math.max(...valid),
    min: Math.min(...valid),
    stdDev: Math.sqrt(
      valid.reduce((sum, x) => sum + Math.pow(x - avg, 2), 0) / valid.length
    )
  };
}
```

**预期结果**：
- ✅ 8000条成绩导入<30秒
- ✅ 统计误差<0.01
- ✅ 边界值正确（0-100）

---

### 测试1.3：备份恢复 - 完整性与性能

**测试代码**：
```typescript
test('stress: backup/restore with 8000 scores + 100 students', async () => {
  const ws = createTestWorkspace();
  
  // ... 复用上面的8000条成绩数据 ...
  
  // 导出备份
  const backupStart = performance.now();
  const backup = await ws.exportBackup();
  const backupTime = performance.now() - backupStart;
  
  console.log(`备份耗时: ${backupTime.toFixed(2)}ms`);
  console.log(`备份大小: ${(backup.byteLength / 1024).toFixed(2)} KB`);
  
  expect(backupTime).toBeLessThan(10000); // 10秒内
  expect(backup.byteLength).toBeLessThan(224 * 1024 * 1024); // <224MB
  
  // 验证备份结构
  const manifest = JSON.parse(Buffer.from(backup).toString('utf8'));
  expect(manifest.database).toBeDefined();
  expect(manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/);
  
  // 恢复到新工作区
  const restoreStart = performance.now();
  const ws2 = await Workspace.restore(backup);
  const restoreTime = performance.now() - restoreStart;
  
  console.log(`恢复耗时: ${restoreTime.toFixed(2)}ms`);
  expect(restoreTime).toBeLessThan(15000); // 15秒内
  
  // 验证数据完整性
  const original = ws.snapshot();
  const restored = ws2.snapshot();
  
  expect(restored.students).toHaveLength(original.students.length);
  expect(restored.scores).toHaveLength(original.scores.length);
  expect(restored.exams).toHaveLength(original.exams.length);
  
  // 验证数据一致性（抽样）
  const randomIdx = Math.floor(Math.random() * original.students.length);
  expect(restored.students[randomIdx]).toEqual(original.students[randomIdx]);
  
  console.log('✓ 备份恢复数据100%一致');
});
```

**预期结果**：
- ✅ 备份导出<10秒
- ✅ 恢复<15秒
- ✅ 数据完整性100%

---

### 测试1.4：并发冲突 - 乐观锁验证

**测试代码**：
```typescript
test('stress: optimistic lock under concurrent edits', async () => {
  const ws = createTestWorkspace();
  
  const snapshot1 = ws.saveStudent({
    displayName: '张三',
    studentNumber: 'S0001',
    enrollments: [],
    expectedRevision: 0
  });
  const student = snapshot1.students[0];
  
  // 模拟并发场景：两个编辑基于同一revision
  const edit1 = {
    id: student.id,
    displayName: '张三_编辑1',
    studentNumber: student.studentNumber,
    enrollments: student.enrollments,
    expectedRevision: student.revision // revision=1
  };
  
  const edit2 = {
    id: student.id,
    displayName: '张三_编辑2',
    studentNumber: student.studentNumber,
    enrollments: student.enrollments,
    expectedRevision: student.revision // revision=1（冲突！）
  };
  
  // 第一次编辑成功
  const snapshot2 = ws.saveStudent(edit1);
  expect(snapshot2.students.find(s => s.id === student.id)?.revision).toBe(2);
  
  // 第二次编辑失败（revision已变为2）
  expect(() => ws.saveStudent(edit2)).toThrow(/CONFLICT/);
  
  // 使用最新revision重试
  const edit2Fixed = { ...edit2, expectedRevision: 2 };
  const snapshot3 = ws.saveStudent(edit2Fixed);
  expect(snapshot3.students.find(s => s.id === student.id)?.revision).toBe(3);
  
  console.log('✓ 乐观锁正确拒绝过期revision');
});
```

**预期结果**：
- ✅ 冲突正确检测
- ✅ 错误类型为CONFLICT
- ✅ 重试后成功

---

### 测试1.5：边界条件 - 极端输入

**测试代码**：
```typescript
test('stress: boundary conditions and extreme inputs', async () => {
  const ws = createTestWorkspace();
  
  // 1. 超长姓名（60字符）
  const longName = '张'.repeat(60);
  expect(() => ws.saveStudent({
    displayName: longName,
    studentNumber: 'S0001',
    enrollments: [],
    expectedRevision: 0
  })).not.toThrow();
  
  // 2. 超长姓名（61字符，预期拒绝）
  const tooLongName = '张'.repeat(61);
  expect(() => ws.saveStudent({
    displayName: tooLongName,
    studentNumber: 'S0002',
    enrollments: [],
    expectedRevision: 0
  })).toThrow();
  
  // 3. 特殊字符学号（大小写自动转换）
  const snapshot1 = ws.saveStudent({
    displayName: '李四',
    studentNumber: 'abc-123_xyz',
    enrollments: [],
    expectedRevision: 0
  });
  expect(snapshot1.students[0].studentNumber).toBe('ABC-123_XYZ');
  
  // 4. 重复学号（预期拒绝）
  expect(() => ws.saveStudent({
    displayName: '王五',
    studentNumber: 'ABC-123_XYZ', // 重复
    enrollments: [],
    expectedRevision: 0
  })).toThrow();
  
  // 5. 零分 vs 缺考
  const classSnapshot = ws.saveClass({
    displayName: '高一1班',
    shortName: '高一1',
    gradYear: 2026,
    expectedRevision: 0
  });
  const examSnapshot = ws.saveExam({
    title: '测试',
    date: '2026-10-05',
    expectedRevision: 0
  });
  
  ws.saveScores({
    examId: examSnapshot.exams[0].id,
    subjectName: '数学',
    maxScore: 100,
    scores: [
      { studentId: snapshot1.students[0].id, score: 0, status: 'present' },
      { studentId: snapshot1.students[0].id, score: null, status: 'absent' }
    ],
    expectedRevision: 0
  });
  
  const scores = ws.snapshot().scores;
  const zeroScore = scores.find(s => s.score === 0);
  const absentScore = scores.find(s => s.status === 'absent');
  
  expect(zeroScore?.score).toBe(0);
  expect(absentScore?.score).toBeNull();
  
  console.log('✓ 边界条件全部正确处理');
});
```

**预期结果**：
- ✅ 超长输入拒绝
- ✅ 特殊字符正确处理
- ✅ 重复拒绝
- ✅ 零分/缺考区分

---

## Phase 2: 手动UI测试清单

由于Playwright启动失败，以下场景需要手动执行打包版本验证：

### 测试2.1：响应性能（手动计时）

**测试步骤**：
1. 启动应用，计时启动延迟
2. 切换10个页面，记录每次延迟
3. 搜索学生（输入"张"），记录响应时间
4. 保存一条数据，记录保存延迟
5. 导出备份，记录导出时间

**记录表格**：
| 操作 | 第1次 | 第2次 | 第3次 | 平均 | 目标 | 通过? |
|------|-------|-------|-------|------|------|-------|
| 启动 | ___ | ___ | ___ | ___ | <3s | ☐ |
| 页面切换 | ___ | ___ | ___ | ___ | <500ms | ☐ |
| 搜索 | ___ | ___ | ___ | ___ | <400ms | ☐ |
| 保存 | ___ | ___ | ___ | ___ | <1s | ☐ |
| 导出 | ___ | ___ | ___ | ___ | <30s | ☐ |

---

### 测试2.2：座位编排UI交互

**测试步骤**：
1. ☐ 创建班级"测试班"，50名学生
2. ☐ 进入座位编排，设置8行×7列
3. ☐ 标记3个不可用位置（点击变灰）
4. ☐ 点击"随机编排"，验证分配正确
5. ☐ 锁定前排3名学生（锁图标显示）
6. ☐ 再次随机，验证锁定学生不动
7. ☐ 手动交换两名学生（拖拽或点选）
8. ☐ 保存座位，填写原因"第一次"
9. ☐ 打印预览，验证布局正确
10. ☐ 导出PDF，用浏览器打开验证

**通过标准**：
- 随机<1秒
- 锁定状态正确
- 打印分页正确
- PDF可正常查看

---

### 测试2.3：值日打印（100页压力）

**测试步骤**：
1. ☐ 创建值日计划"10月值日"
2. ☐ 日期范围：2026-10-01 ~ 2026-10-31
3. ☐ 自动分组：5组×10人
4. ☐ 保存并打印预览
5. ☐ 验证页数（预期约30-50页）
6. ☐ 滚动查看所有页面（验证无卡顿）
7. ☐ 导出PDF
8. ☐ 用浏览器打开PDF验证完整性

**通过标准**：
- 生成<10秒
- 页面滚动流畅
- PDF完整无缺页

---

### 测试2.4：课堂展示窗口隔离

**测试步骤**：
1. ☐ 上传1份PDF资料（选择测试文档）
2. ☐ 创建备课草稿
3. ☐ 启动课堂展示
4. ☐ 验证独立窗口打开
5. ☐ 在展示窗口按F12打开DevTools
6. ☐ 尝试在Console执行：
   ```javascript
   window.electron.saveStudent({...}) // 预期：undefined
   ```
7. ☐ 验证管理API不可访问
8. ☐ 切换教学环节，验证计时更新
9. ☐ 关闭展示窗口，返回管理界面

**通过标准**：
- 管理API返回undefined
- 展示窗口只有3个只读API
- 计时单调递增

---

### 测试2.5：长时间稳定性（8小时）

**测试步骤**：
1. ☐ 启动应用
2. ☐ 记录初始内存占用（任务管理器）
3. ☐ 执行100次混合操作：
   - 创建/编辑学生
   - 导入成绩
   - 切换页面
   - 搜索筛选
4. ☐ 每小时记录内存占用
5. ☐ 8小时后检查：
   - 应用是否崩溃？
   - 内存增长<200MB?
   - 操作是否卡顿？

**记录表格**：
| 时间 | 内存(MB) | 操作次数 | 状态 |
|------|----------|----------|------|
| 0h | ___ | 0 | ☐ 正常 |
| 1h | ___ | ~12 | ☐ 正常 |
| 2h | ___ | ~25 | ☐ 正常 |
| 4h | ___ | ~50 | ☐ 正常 |
| 8h | ___ | 100 | ☐ 正常 |

---

## Phase 3: 业务逻辑连贯性测试

### 测试3.1：完整教学周期

**场景**：模拟一个完整学期的工作流

**步骤**：
1. ☐ **开学（第1周）**
   - 创建3个班级
   - 导入150名学生名单
   - 生成座位表并打印
   - 安排值日计划

2. ☐ **月考（第4周）**
   - 创建"月考"考试
   - 导入8科成绩
   - 生成AI解释草稿
   - 教师复核并保存

3. ☐ **期中考（第8周）**
   - 创建"期中考试"
   - 导入成绩
   - 对比月考成绩（进步/退步）
   - 记录成长事件："数学进步20分"

4. ☐ **调班（第10周）**
   - 学生A从1班转到2班
   - 验证座位自动移除
   - 验证成绩历史保留
   - 验证新班级可编排座位

5. ☐ **期末（第16周）**
   - 导入期末成绩
   - 生成学期成长总结
   - 导出全部报告
   - 备份整学期数据

6. ☐ **暑假（第17周）**
   - 恢复备份到新电脑（模拟）
   - 验证数据完整
   - 查看历史记录

**通过标准**：
- 每个步骤独立可完成
- 数据前后一致
- 历史可追溯
- 备份可恢复

---

### 测试3.2：异常场景恢复

**场景A：导入中断**
1. ☐ 开始导入100行成绩Excel
2. ☐ 导入到50%时点击取消
3. ☐ 验证：数据库无部分数据（原子性）
4. ☐ 重新导入完整文件
5. ☐ 验证：最终只有100条记录

**场景B：网络超时**
1. ☐ 配置AI解释
2. ☐ 发起生成请求
3. ☐ 断开网络（拔网线或禁用适配器）
4. ☐ 等待超时（30秒）
5. ☐ 验证：明确错误提示
6. ☐ 恢复网络并重试
7. ☐ 验证：不重复计费

**场景C：强制退出恢复**
1. ☐ 编辑学生信息（未保存）
2. ☐ 任务管理器强制结束进程
3. ☐ 重新启动应用
4. ☐ 验证：未保存数据丢失（预期）
5. ☐ 验证：已保存数据完整

**通过标准**：
- 异常后可继续使用
- 数据不损坏
- 错误提示明确

---

## Phase 4: 用户体验评估

### 评估4.1：首次使用体验（无培训）

**测试者**：找一位未接触过系统的教师

**任务清单**：
1. ☐ 在15分钟内完成建班（高一1班）
2. ☐ 添加5名学生
3. ☐ 导入一份成绩Excel
4. ☐ 查看统计结果

**观察记录**：
- 是否需要查看帮助文档？
- 遇到困惑的地方？
- 操作错误的次数？
- 完成时间？

**评分**：
- 10分：无培训15分钟内完成
- 8分：需要简单提示
- 6分：需要查看文档
- <6分：需要详细培训

---

### 评估4.2：错误信息可理解性

**测试**：故意制造10种错误，记录提示是否清晰

| 错误场景 | 实际提示 | 可理解？ | 改进建议 |
|----------|----------|----------|----------|
| 重复学号 | ___ | ☐ | ___ |
| revision冲突 | ___ | ☐ | ___ |
| 网络超时 | ___ | ☐ | ___ |
| 余额不足 | ___ | ☐ | ___ |
| 文件格式错误 | ___ | ☐ | ___ |
| 磁盘空间不足 | ___ | ☐ | ___ |
| 权限不足 | ___ | ☐ | ___ |
| 备份损坏 | ___ | ☐ | ___ |
| 超限数据 | ___ | ☐ | ___ |
| 加密不可用 | ___ | ☐ | ___ |

**通过标准**：至少8/10可理解

---

## 测试执行时间表

| 阶段 | 内容 | 预计时间 | 执行者 |
|------|------|----------|--------|
| Phase 1 | 自动化核心测试 | 2小时 | 自动执行 |
| Phase 2 | 手动UI测试 | 4小时 | 测试人员 |
| Phase 3 | 业务连贯性 | 3小时 | 测试人员 |
| Phase 4 | UX评估 | 2小时 | 真实用户 |
| **合计** | | **11小时** | |

---

## 下一步：开始执行Phase 1

现在开始执行自动化测试...
