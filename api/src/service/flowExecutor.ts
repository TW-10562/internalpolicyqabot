import { buildNodeExecutor } from '@/flow/nodes/executors'
import { RunnableLambda } from '@langchain/core/runnables'

export async function executeFlow(json_schema: any, input: any): Promise<any> {
    const { nodes, edges } = JSON.parse(json_schema)

    const nodeMap = new Map<string, any>()
    for (const node of nodes) {
        const executor = buildNodeExecutor(node)
        nodeMap.set(node.id, executor)
    }

    const outputMap = new Map<string, string[]>()
    for (const edge of edges) {
        if (!outputMap.has(edge.source)) outputMap.set(edge.source, [])
        outputMap.get(edge.source)!.push(edge.target)
    }

    const allTargets = new Set(edges.map((e: any) => e.target))
    const entryNode = nodes.find((n: any) => !allTargets.has(n.id))
    if (!entryNode) throw new Error('入口节点未找到')

    return await runNodeRecursive(entryNode.id, input, nodeMap, outputMap)
}

async function runNodeRecursive(
    nodeId: string,
    input: any,
    nodeMap: Map<string, RunnableLambda<any, any>>,
    outputMap: Map<string, string[]>
): Promise<any> {
    try {
        const executor = nodeMap.get(nodeId)
        if (!executor) throw new Error(`节点未定义：${nodeId}`)

        const result = await executor.invoke(input)
        const nextNodes = outputMap.get(nodeId) || []

        // support if node
        if (typeof result === 'object' && result && result.next) {
            const branchTarget = nextNodes.find((nid) => nid === result.next || nid.includes(result.next))
            if (branchTarget) {
                return await runNodeRecursive(branchTarget, result.output ?? result, nodeMap, outputMap)
            }
            return result
        }

        if (typeof result === 'object' && result && '$branch' in result) {
            const branchTarget = nextNodes.find((nid) => nid.includes(result.$branch))
            if (branchTarget) return await runNodeRecursive(branchTarget, result, nodeMap, outputMap)
            return result
        }

        // last node
        if (nextNodes.length === 0) return result

        // common node execution
        return await runNodeRecursive(nextNodes[0], result, nodeMap, outputMap)
    } catch (error) {
        console.error("执行节点出错：", error)
        throw error;
    }
}

