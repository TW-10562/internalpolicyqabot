import FlowDefinitions from '@/mysql/model/flow_definitions.model';
import { executeFlow } from '@/service/flowExecutor';
import { IFlowDefinitionsQuerySerType, IFlowDefinitionsQueryType, IFlowDefinitonsSer, IFlowDefinitonsTask } from '@/types/flow';
import { userType } from '@/types/user';
import { formatHumpLineTransfer } from '@/utils';
import { add, put, queryById, queryPage } from '@/utils/mapper';
import { Context } from 'koa';
import { nanoid } from 'nanoid';


export const upsertMid = async (ctx: Context, next: () => Promise<void>) => {
    try {
        const { userName } = ctx.state.user as userType;
        const addContent = ctx.request.body as IFlowDefinitonsTask;

        let flowId = addContent.id;
        if (!flowId) {
            flowId = nanoid()
        }

        const flowContent = formatHumpLineTransfer({
            ...addContent,
            id: flowId,
            createBy: userName,
            updateBy: userName
        }, 'line') as IFlowDefinitonsSer;

        if (addContent.id) {
            await put<IFlowDefinitonsSer>(FlowDefinitions, { id: flowId }, flowContent);
        } else {
            await add<IFlowDefinitonsSer>(FlowDefinitions, flowContent);
        }

        ctx.state.formatData = {
            flowId
        };

        await next();
    } catch (error) {
        console.error(error);
        return ctx.app.emit(
            'error',
            {
                code: '500',
                message: 'error happen',
            },
            ctx,
        );
    }
}

export const getListMid = async (ctx: Context, next: () => Promise<void>) => {
    try {
        const { pageNum, pageSize } = ctx.query as unknown as IFlowDefinitionsQueryType;
        const newParams = { pageNum, pageSize } as IFlowDefinitionsQuerySerType;
        const res = await queryPage<IFlowDefinitionsQuerySerType>(FlowDefinitions, newParams);

        ctx.state.formatData = res;
        await next();
    } catch (error) {
        console.error(error);
        return ctx.app.emit(
            'error',
            {
                code: '500',
                message: 'error happen',
            },
            ctx,
        );
    }

}

export const getMid = async (ctx: Context, next: () => Promise<void>) => {
    const { id } = ctx.params;
    const flows = await queryById(FlowDefinitions, {
        id
    });

    ctx.state.formatData = {
        flow: flows[0]
    };

    await next();
}

export const deleteMid = async (ctx: Context, next: () => Promise<void>) => {
    const { id } = ctx.params;

    await FlowDefinitions.destroy({
        where: { id },
    });

    await next();

}

export const executeMid = async (ctx: Context, next: () => Promise<void>) => {
    try {
        const { flowId, input } = ctx.request.body

        if (!flowId || !input) {
            ctx.status = 500;
            ctx.app.emit(
                'error',
                { code: '500', message: 'invalid param' },
                ctx,
            );
        }

        const flow = await queryById<IFlowDefinitonsSer>(FlowDefinitions, { id: flowId });

        if (!flow) {
            ctx.status = 500;
            ctx.app.emit(
                'error',
                { code: '500', message: 'flow not found' },
                ctx,
            );
        }

        const result = await executeFlow(flow.json_schema, input)
        ctx.state.formatData = {
            result
        };

        await next();
    } catch (error) {
        ctx.status = 500;
        ctx.app.emit(
            'error',
            { code: '500', message: 'error happen' },
            ctx,
        );
    }
};
