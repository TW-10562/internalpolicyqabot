# Node Doc

## inputNode

```ts
// input: "hello"
{ input: "hello" }

// input: { input: "write a pom", options: { max_tokens: 128 } }
{
    input: "write a pom",
    options: {
        max_tokens: 128
    }
}

// input: { messages: [ { role: "user", content: "write a pom" } ] }
{
    messages: [
        {
            role: "user",
            content: "write a pom"
        }
    ]
}

// input: null
{}

// input: 123
{ input: 123 }

```

## openaiNode

```ts
// -------------------------- chat --------------------------
// setting
{
  type: 'chat',
  apiKey,
  model: 'gpt-4-turbo',
  options: {
    temperature: 0.9,
    max_tokens: 512,
    top_p: 0.8,
    stop: ['###'],
    n: 2,
    response_format: { type: 'json_object' },
    tools: [
      /* function calling 定义 */
    ],
  },
}
// input
{
    input: "write a pom",
    // or
    messages: [
        { role: "user", content: "write a pom" }
    ],
    // 局部 options（优先级高于节点 options）
    options: {
        max_tokens: 128
    }
}

// -------------------------- 音频识别 --------------------------
// setting
{
  type: 'audio',
  apiKey,
  audioFormat: 'mp3',
  options: { language: 'zh' },
}
// input
{
    audioBuffer: fs.readFileSync("./test.mp3"),
    options: {}
}
```

## ollamaNode

```ts
// -------------------------- chat --------------------------
// setting
{
    model: "qwen:latest",
    type: "chat",
  baseUrl: "https://6vml1c4r-11435.asse.devtunnels.ms/",
  // Use local Ollama when running locally:
  // baseUrl: "http://localhost:11435/",
    options: {
        temperature: 0.7,
        stream: false,
    }
}
// input
{
    input: "write a pom",
    // or
    messages: [
        { role: "user", content: "write a pom" }
    ],
    // 局部 options（优先级高于节点 options）
    options: {
        max_tokens: 128
    }
}

// -------------------------- embedding --------------------------
// setting
{
    model: "nomic-embed-text",
    type: "embedding",
}
// input
{
    input: ["hello", "世界"]
}
```

## claudeNode

```ts
// -------------------------- chat --------------------------
// setting
{
    apiKey: "sk-ant-xxx",
    model: "claude-3-haiku-20240307",
    options: { temperature: 0.3 }
}
// input
{
    input: "write a pom",
    // or
    messages: [
        { role: "user", content: "write a pom" }
    ]
}
```

## ifNode

```ts
// setting
{
  condition: 'input.score >= 60',
  trueBranch: 'openaiNode',
  falseBranch: 'ollamaNode',
}

// json_schema
{
  "nodes": [
    { "id": "1", "type": "input", "data": {} },
    { "id": "2", "type": "if", "data": { "condition": "input.score >= 60" } },
    { "id": "3", "type": "pass", "data": {} },
    { "id": "4", "type": "fail", "data": {} }
  ],
  "edges": [
    { "source": "1", "target": "2" },
    { "source": "2", "target": "3", "label": "true" },   // trueBranch
    { "source": "2", "target": "4", "label": "false" }   // falseBranch
  ]
}


// input
{ score: 85 }
// { next: "passNode", output: { score: 85 } }

{ score: 42 }
// { next: "failNode", output: { score: 42 } }
```

## httpNode

```ts
// setting

{
  url: 'https://api.example.com/user/info',
  method: 'get', // 可选："get" | "post" | "put" | "delete"
  headers: { Authorization: 'Bearer xxx' }, // 可选
  params: { id: '123' }, // 可选，GET/DELETE常用
  data: { name: 'Tom' }, // 可选，POST/PUT常用
  timeout: 5000 // 可选，单位ms
}


// json_schema
{
  "nodes": [
    { "id": "1", "type": "input", "data": {} },
    {
      "id": "2",
      "type": "http",
      "data": {
        "url": "https://api.example.com/user/info",
        "method": "get",
        "headers": { "Authorization": "Bearer xxx" },
        "params": { "id": "123" },
        "timeout": 5000
      }
    }
  ],
  "edges": [
    { "source": "1", "target": "2" }
  ]
}

// input

// 1. 全部用节点内配置（setting/json_schema）
input = {}

// 2. 部分参数动态传递

// 假设 httpNode 配置是：
{
  url: 'https://api.example.com/user/info',
  method: 'post'
  // params, data 为空
}

// 则
input = {
  params: { id: '888' },
  data: { name: 'Jerry', age: 20 }
}

```

## mysqlNode

```ts
// setting
{
  sql: "SELECT * FROM users WHERE id = :id",
  replacements: { id: 123 },        // 可用对象或数组
  type: "SELECT"                    // 可选："SELECT" | "UPDATE" | "INSERT" | "DELETE"
}

// json_schema
{
  "nodes": [
    {
      "id": "3",
      "type": "mysql",
      "data": {
        "sql": "SELECT * FROM users WHERE id = :id",
        "replacements": { "id": 123 }
      }
    }
  ],
  "edges": [
    { "source": "2", "target": "3" }
  ]
}

// input

// 1：完全用配置（setting/json_schema）里的 replacements

input = {}

// 2：动态参数（上游传入/流转过程填充）
input = { id: 456 }

// 3：数组参数（如 sql 写 WHERE id = ?，则 input = [456]）

```

## redisNode

## postgesNode
