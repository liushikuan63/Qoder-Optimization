---
name: local-spring-mybatis
description: "补充 Spring 与 MyBatis 的事务、参数绑定、映射和查询性能检查；用于这些后端实现问题。触发词：MyBatis、Mapper、XML 映射、事务、参数绑定、N+1、慢查询。不替代本机环境预检。"
license: MIT
metadata:
  origin: local-adaptation
---

# 本地 Spring 与 MyBatis

先从当前 pom/Gradle、父依赖、配置、mapper 与调用路径确认 JDK、Spring、MyBatis 版本及项目风格。沿实际 controller/job → service → mapper 处理，不把项目迁移到另一套数据访问框架。

## 有针对性的实现检查
- Java 8 项目不能直接采用 record、var、List.of、Stream.toList 等高版本示例；Spring 5 的 javax 与 Spring 6 的 jakarta 也不能混用。新写法以当前目标版本与既有代码为准。
- 事务边界围绕完整业务操作，核对代理入口、自调用、异常传播、rollbackFor、多数据源与异步线程。不要因方法上写了 @Transactional 就宣称实际已回滚；根据当前代理模式及配置检查真实调用。
- MyBatis 值用 #{...} 绑定；${...} 是 SQL 文本替换，动态列名/排序需要服务端闭合映射或固定语句。多参数核对 @Param、XML namespace/id 和 DTO/resultMap；租户范围来自可信上下文。
- dynamic SQL 的空集合、空过滤条件、批量删除/更新边界必须明确，不能因条件被省略就更新全表。复杂连接检查行倍增、去重与分页；nested select 检查 N+1，而不是仅看单次 SQL 很快。
- 连接和 session 生命周期沿现有 Spring 管理方式，不手动关闭受管理的 session。批处理检查 flush 时机、部分失败、幂等性与恢复位置；缓存和异步功能只有实际需求时引入。

## 验证
逻辑测试之外，参数绑定、方言、约束与事务回滚优先用现有数据库集成测试验证；H2/mock 不能单独证明生产引擎行为。按项目 Maven/Gradle 门禁核实实际测试数量和跳过情况。数据库结构变更转入 local-db-migrations；只排环境问题时继续使用本机已有项目工作流程。

参考参数绑定：[MyBatis 官方 XML 说明](https://mybatis.org/mybatis-3/sqlmap-xml.html)，使用时核对项目版本。
