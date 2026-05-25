# ZipViewer — VSCode 插件设计文档

## 概述

一个 VSCode 插件，让用户可以直接在资源管理器中像打开文件夹一样打开 ZIP 文件（及 Office Open XML 格式），以只读方式浏览内容，同时支持编辑和写回。

## 需求

### 核心功能

- 在 VSCode 资源管理器中将 ZIP 文件展开为虚拟文件夹，体验与普通目录一致
- 点击 ZIP 内文件直接在编辑器中打开，支持语法高亮、格式化、IntelliSense 等所有编辑器功能
- 支持对 ZIP 内文件的完整操作：查看、编辑、新建、删除、重命名
- 支持拖拽文件进 ZIP
- 修改后 Ctrl+S 单文件即时写回 ZIP
- 提供 `Save All Changes` 命令进行批量保存

### 支持的格式

- `.zip`
- `.docx`、`.pptx`、`.xlsx`（Office Open XML，本质为 ZIP）
- 用户可通过设置项 `zipviewer.additionalExtensions` 自行添加其他扩展名（如 `.jar`、`.apk`、`.epub`）

### 范围限制

- 单层 ZIP，不递归展开嵌套 ZIP
- 不支持加密/密码保护的 ZIP
- 不做大文件特殊优化（第一版）

## 架构

### 三层架构

```
┌─────────────────────────────────┐
│       VSCode Explorer           │
│   (zip:// scheme auto-mounts)   │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│    ZipFileSystemProvider        │
│  implements FileSystemProvider  │
│  - readFile / writeFile         │
│  - readDirectory / createDir    │
│  - delete / rename              │
│  - watch (event emitter)        │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│      ZipArchiveManager          │
│  - parse ZIP into memory tree   │
│  - read entry content (lazy)    │
│  - mutate in-memory tree        │
│  - flush to disk (write-back)   │
└─────────────────────────────────┘
```

### 各层职责

**入口层（Extension Entry — `extension.ts`）**
- 注册 `zip://` scheme 的 `FileSystemProvider`
- 注册命令（打开、批量保存、关闭）
- 监听 `.zip`/`.docx`/`.pptx`/`.xlsx` 文件的打开事件
- 注册右键菜单项

**虚拟文件系统层（`ZipFileSystemProvider`）**
- 实现 `vscode.FileSystemProvider` 接口的所有方法
- 将 URI 解析路由到对应的 `ZipArchiveManager` 实例
- 管理 `onDidChangeFile` 事件发射

**ZIP 引擎层（`ZipArchiveManager`）**
- 封装单个 ZIP 文件的完整生命周期
- 解析 ZIP 目录结构到内存，文件内容懒加载
- 提供增删改查操作
- 负责写回磁盘

**实例注册表（`ZipManagerRegistry`）**
- 管理多个同时打开的 ZIP 文件对应的 `ZipArchiveManager` 实例
- 根据 URI 路由到正确的实例
- 处理实例的创建和销毁

## 数据流

### 打开 ZIP

1. 用户在资源管理器中右键点击 `.zip` 文件，选择"Open as Archive"（或通过命令面板执行 `Zip Viewer: Open Archive`）
2. 插件读取 ZIP 文件的二进制数据，交给 `ZipArchiveManager` 解析目录结构
3. 以 `zip://<zip文件绝对路径>/` 为根路径，通过 `vscode.workspace.updateWorkspaceFolders()` 将虚拟文件系统挂载到资源管理器
4. 用户在资源管理器中看到 ZIP 内容像普通文件夹一样展开

### 读取文件

1. 用户点击 ZIP 内的某个文件
2. VSCode 调用 `ZipFileSystemProvider.readFile(uri)`
3. Provider 从 `ZipArchiveManager` 中懒加载并解压该文件内容，返回 `Uint8Array`
4. VSCode 在编辑器中打开，自动获得所有编辑器功能

### 修改 + 单文件保存（Ctrl+S）

1. 用户编辑文件后按 Ctrl+S
2. VSCode 调用 `ZipFileSystemProvider.writeFile(uri, content)`
3. Provider 将新内容更新到 `ZipArchiveManager` 的内存树中
4. 调度防抖写回（300ms）：将整个内存树重新打包写入临时文件 → 原子替换原文件
5. 触发 `onDidChangeFile` 事件通知 VSCode

### 批量保存

- 提供命令 `Zip Viewer: Save All Changes`，内部调用 `vscode.workspace.saveAll()` 触发所有脏文件保存
- 写回采用**防抖机制**（300ms）：每次 `writeFile` 更新内存树后，调度一次延迟写回；如果短时间内有多次 `writeFile`（如 Save All 触发的），自动合并为一次磁盘写入
- 无需模式切换——单文件 Ctrl+S 和批量保存使用相同的代码路径，防抖机制自然处理合并

### 新建 / 删除 / 重命名

- `createDirectory`：在内存树中新增目录节点 → 写回
- `delete`：从内存树中移除节点 → 写回
- `rename`：内存树中移动节点 → 写回
- VSCode 资源管理器原生支持右键菜单，无需额外 UI

### 写回策略

采用**先写临时文件再原子替换**的方式，保护原文件安全：

1. 将内存中完整的 ZIP 结构写入同目录下的 `.zip.tmp` 临时文件
2. 删除原 ZIP 文件
3. 将 `.tmp` 重命名为原文件名

## 技术选型

| 项目     | 选型                   | 理由                                               |
| -------- | ---------------------- | -------------------------------------------------- |
| 语言     | TypeScript             | VSCode 插件标准语言                                |
| 构建工具 | esbuild                | VSCode 官方推荐，快速且产物小                      |
| ZIP 库   | jszip                  | 纯 JS 实现，无原生依赖，支持读写，API 成熟稳定    |
| 测试     | Mocha + VSCode Test    | VSCode 插件标准测试方案                            |
| 最低版本 | VSCode 1.80+           | FileSystemProvider API 稳定                        |

## 项目结构

```
zipviewer/
├── .vscode/
│   └── launch.json              # 插件调试配置
├── src/
│   ├── extension.ts             # 入口：激活/注销，注册命令和 provider
│   ├── zipFileSystemProvider.ts # FileSystemProvider 实现
│   ├── zipArchiveManager.ts     # 单个 ZIP 文件的内存模型和读写操作
│   ├── zipManagerRegistry.ts    # 管理多个打开的 ZIP 实例
│   └── utils.ts                 # 路径解析、URI 转换等工具函数
├── test/
│   └── suite/
│       ├── extension.test.ts
│       └── zipArchiveManager.test.ts
├── package.json                 # 插件清单
├── tsconfig.json
├── esbuild.config.mjs
└── README.md
```

## 可扩展性

### ArchiveAdapter 接口

`ZipArchiveManager` 实现以下接口，未来支持其他格式只需新增 adapter：

```typescript
interface ArchiveAdapter {
  parse(data: Uint8Array): Promise<void>;
  listEntries(): ArchiveEntry[];
  readEntry(path: string): Promise<Uint8Array>;
  writeEntry(path: string, data: Uint8Array): void;
  deleteEntry(path: string): void;
  renameEntry(oldPath: string, newPath: string): void;
  toBuffer(): Promise<Uint8Array>;
}
```

### 用户可配置扩展名

通过 `zipviewer.additionalExtensions` 设置项，用户可以添加自定义扩展名，无需修改代码。

## 错误处理与边界情况

### 文件锁与并发

- 写回时使用 per-ZIP 实例的内存互斥锁，防止多次 Ctrl+S 并发写入
- 如果外部程序占用 ZIP 文件导致写入失败，弹出错误提示让用户重试

### ZIP 文件外部变更

- 使用 `vscode.workspace.createFileSystemWatcher` 监听原 ZIP 文件的变更
- 当检测到外部变更时：
  - 如果当前**没有未保存的修改**：弹出提示"ZIP 文件已被外部修改，是否重新加载？"，用户确认后重新解析 ZIP
  - 如果当前**有未保存的修改**：弹出提示"ZIP 文件已被外部修改，且您有未保存的更改。重新加载将丢失这些更改，是否继续？"，提供"重新加载"和"忽略"两个选项
- 如果外部删除了 ZIP 文件：提示用户，自动卸载该 ZIP 的虚拟文件系统

### 写入失败保护

- 临时文件写入成功后才替换原文件
- 如果写入过程中崩溃，临时文件残留但原文件不会损坏
- 如果替换步骤失败（权限问题等），提示用户，临时文件保留作为备份

### 非法 ZIP 文件

- 解析失败时弹出友好的错误提示："无法打开此文件，可能不是有效的 ZIP 格式"

### 二进制文件

- ZIP 内的二进制文件正常返回 `Uint8Array`，VSCode 根据自身能力决定展示方式

### 关闭 / 清理

- 关闭 ZIP 时释放 `ZipArchiveManager` 实例，清理内存
- 如果有未保存的修改，提示用户是否保存

## 插件配置

### package.json 关键配置

- **activationEvents**：`onFileSystem:zip`
- **contributes.commands**：
  - `zipviewer.openArchive` — 打开 ZIP 文件
  - `zipviewer.saveAll` — 批量保存所有修改
  - `zipviewer.closeArchive` — 关闭/卸载 ZIP
- **contributes.menus**：资源管理器中 `.zip`/`.docx`/`.pptx`/`.xlsx` 文件右键菜单添加"Open as Archive"
- **contributes.configuration**：`zipviewer.additionalExtensions` — 用户自定义扩展名列表

### 右键菜单触发条件

```
resourceExtname =~ /\.(zip|docx|pptx|xlsx)$/i
```

同时合并用户设置中的 `additionalExtensions`。
