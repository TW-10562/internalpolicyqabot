import type { OutputPreparer } from "@aviary-ai/async-tasks";
import { CHAT_TASK_TYPE, prepareChatOutputs, processChatTask } from "./chat";

export type TaskProcessor = (taskId: string) => Promise<void>;

interface TaskTypeRegistration {
    type: string;
    outputPreparer: OutputPreparer;
    processor: TaskProcessor;
}

const taskTypeRegistry: TaskTypeRegistration[] = [
    {
        type: CHAT_TASK_TYPE,
        outputPreparer: prepareChatOutputs,
        processor: processChatTask,
    },
    // Add more task types here
];


export function getRegisteredTaskTypes(): string[] {
    return taskTypeRegistry.map(reg => reg.type);
}

export function getOutputPreparer(): OutputPreparer {
    return (type, formData) => {
        const registration = taskTypeRegistry.find(reg => reg.type === type);
        if (registration) {
            return registration.outputPreparer(type, formData);
        }
        // Fallback for unregistered types
        console.warn(`No output preparer registered for task type: ${type}`);
        return [];
    };
}

export function getTaskProcessor(type: string): TaskProcessor | undefined {
    const registration = taskTypeRegistry.find(reg => reg.type === type);
    return registration?.processor;
}


export async function processTask(job: any): Promise<void> {
    const { taskId, taskType } = job.data;

    console.log(`Processing job for task: ${taskId}, type: ${taskType}`);

    const registration = taskTypeRegistry.find(reg => reg.type === taskType);

    if (!registration) {
        console.error(`No processor registered for task type: ${taskType}`);
        throw new Error(`No processor registered for task type: ${taskType}`);
    }

    await registration.processor(taskId);
}

export const combinedOutputPreparer = getOutputPreparer();
