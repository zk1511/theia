/********************************************************************************
 * Copyright (C) 2017 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable } from 'inversify';
import { TaskService } from './task-service';
import { TaskInfo, TaskConfiguration } from '../common/task-protocol';
import { TaskDefinitionRegistry } from './task-definition-registry';
import URI from '@theia/core/lib/common/uri';
import { TaskActionProvider } from './task-action-provider';
import { QuickOpenHandler, QuickOpenService, QuickOpenOptions } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { FileSystem } from '@theia/filesystem/lib/common';
import { QuickOpenModel, QuickOpenItem, QuickOpenActionProvider, QuickOpenMode, QuickOpenGroupItem, QuickOpenGroupItemOptions } from '@theia/core/lib/common/quick-open-model';
import { TaskNameResolver } from './task-name-resolver';
import { TaskConfigurationManager } from './task-configuration-manager';

@injectable()
export class QuickOpenTask implements QuickOpenModel, QuickOpenHandler {

    protected items: QuickOpenItem[];
    protected actionProvider: QuickOpenActionProvider | undefined;

    readonly prefix: string = 'task ';

    readonly description: string = 'Run Task';

    @inject(TaskService)
    protected readonly taskService: TaskService;

    @inject(QuickOpenService)
    protected readonly quickOpenService: QuickOpenService;

    @inject(TaskActionProvider)
    protected readonly taskActionProvider: TaskActionProvider;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(TaskDefinitionRegistry)
    protected readonly taskDefinitionRegistry: TaskDefinitionRegistry;

    @inject(TaskNameResolver)
    protected readonly taskNameResolver: TaskNameResolver;

    @inject(FileSystem)
    protected readonly fileSystem: FileSystem;

    @inject(TaskConfigurationManager)
    protected readonly taskConfigurationManager: TaskConfigurationManager;

    /** Initialize this quick open model with the tasks. */
    async init(): Promise<void> {
        const recentTasks = this.taskService.recentTasks;
        const configuredTasks = await this.taskService.getConfiguredTasks();
        const providedTasks = await this.taskService.getProvidedTasks();

        const { filteredRecentTasks, filteredConfiguredTasks, filteredProvidedTasks } = this.getFilteredTasks(recentTasks, configuredTasks, providedTasks);
        const isMulti: boolean = this.workspaceService.isMultiRootWorkspaceOpened;
        this.items = [];
        this.items.push(
            ...filteredRecentTasks.map((task, index) => {
                const item = new TaskRunQuickOpenItem(task, this.taskService, isMulti, {
                    groupLabel: index === 0 ? 'recently used tasks' : undefined,
                    showBorder: false
                }, this.taskNameResolver);
                item['taskDefinitionRegistry'] = this.taskDefinitionRegistry;
                return item;
            }),
            ...filteredConfiguredTasks.map((task, index) => {
                const item = new TaskRunQuickOpenItem(task, this.taskService, isMulti, {
                    groupLabel: index === 0 ? 'configured tasks' : undefined,
                    showBorder: (
                        filteredRecentTasks.length <= 0
                            ? false
                            : index === 0 ? true : false
                    )
                }, this.taskNameResolver);
                item['taskDefinitionRegistry'] = this.taskDefinitionRegistry;
                return item;
            }),
            ...filteredProvidedTasks.map((task, index) => {
                const item = new TaskRunQuickOpenItem(task, this.taskService, isMulti, {
                    groupLabel: index === 0 ? 'detected tasks' : undefined,
                    showBorder: (
                        filteredRecentTasks.length <= 0 && filteredConfiguredTasks.length <= 0
                            ? false
                            : index === 0 ? true : false
                    )
                }, this.taskNameResolver);
                item['taskDefinitionRegistry'] = this.taskDefinitionRegistry;
                return item;
            })
        );

        this.actionProvider = this.items.length ? this.taskActionProvider : undefined;

        if (!this.items.length) {
            this.items.push(new QuickOpenItem({
                label: 'No tasks found',
                run: (mode: QuickOpenMode): boolean => false
            }));
        }
    }

    async open(): Promise<void> {
        await this.init();
        this.quickOpenService.open(this, {
            placeholder: 'Select the task to run',
            fuzzyMatchLabel: true,
            fuzzySort: false
        });
    }

    getModel(): QuickOpenModel {
        return this;
    }

    getOptions(): QuickOpenOptions {
        return {
            fuzzyMatchLabel: true,
            fuzzySort: false
        };
    }

    attach(): void {
        this.items = [];
        this.actionProvider = undefined;

        this.taskService.getRunningTasks().then(tasks => {
            if (!tasks.length) {
                this.items.push(new QuickOpenItem({
                    label: 'No tasks found',
                    run: (_mode: QuickOpenMode): boolean => false
                }));
            }
            for (const task of tasks) {
                // can only attach to terminal processes, so only list those
                if (task.terminalId) {
                    this.items.push(
                        new TaskAttachQuickOpenItem(
                            task,
                            this.getRunningTaskLabel(task),
                            this.taskService
                        )
                    );
                }
            }
            this.quickOpenService.open(this, {
                placeholder: 'Choose task to open',
                fuzzyMatchLabel: true,
                fuzzySort: true
            });
        });
    }

    async configure(): Promise<void> {
        this.items = [];
        this.actionProvider = undefined;
        const isMulti: boolean = this.workspaceService.isMultiRootWorkspaceOpened;

        const configuredTasks = await this.taskService.getConfiguredTasks();
        const providedTasks = await this.taskService.getProvidedTasks();

        // check if tasks.json exists. If not, display "Create tasks.json file from template"
        // If tasks.json exists and empty, display 'Open tasks.json file'
        let isFirstGroup = true;
        const { filteredConfiguredTasks, filteredProvidedTasks } = this.getFilteredTasks([], configuredTasks, providedTasks);
        const groupedTasks = this.getGroupedTasksByWorkspaceFolder([...filteredConfiguredTasks, ...filteredProvidedTasks]);
        if (groupedTasks.has(undefined)) {
            const configs = groupedTasks.get(undefined)!;
            this.items.push(
                ...configs.map(taskConfig => {
                    const item = new TaskConfigureQuickOpenItem(
                        taskConfig,
                        this.taskService,
                        this.taskNameResolver,
                        this.workspaceService,
                        isMulti,
                        { showBorder: false }
                    );
                    item['taskDefinitionRegistry'] = this.taskDefinitionRegistry;
                    return item;
                })
            );
            isFirstGroup = false;
        }

        const rootUris = (await this.workspaceService.roots).map(rootStat => rootStat.uri);
        for (const rootFolder of rootUris) {
            const uri = new URI(rootFolder).withScheme('file');
            const folderName = uri.displayName;
            if (groupedTasks.has(uri.toString())) {
                const configs = groupedTasks.get(uri.toString())!;
                this.items.push(
                    ...configs.map((taskConfig, index) => {
                        const item = new TaskConfigureQuickOpenItem(
                            taskConfig,
                            this.taskService,
                            this.taskNameResolver,
                            this.workspaceService,
                            isMulti,
                            {
                                groupLabel: index === 0 && isMulti ? folderName : '',
                                showBorder: !isFirstGroup && index === 0
                            }
                        );
                        item['taskDefinitionRegistry'] = this.taskDefinitionRegistry;
                        return item;
                    })
                );
            } else {
                const existTheiaTaskConfigFile = await this.fileSystem.exists(uri.resolve('.theia').resolve('tasks.json').toString());
                const existVsCodeTaskConfigFile = await this.fileSystem.exists(uri.resolve('.vscode').resolve('tasks.json').toString());
                const existTaskConfigFile = existTheiaTaskConfigFile || existVsCodeTaskConfigFile;
                this.items.push(new QuickOpenGroupItem({
                    label: existTaskConfigFile ? 'Open tasks.json file' : 'Create tasks.json file from template',
                    run: (mode: QuickOpenMode): boolean => {
                        if (mode !== QuickOpenMode.OPEN) {
                            return false;
                        }
                        this.taskConfigurationManager.openConfiguration(uri.toString());
                        return true;
                    },
                    showBorder: !isFirstGroup,
                    groupLabel: isMulti ? folderName : ''
                }));
            }
            isFirstGroup = false;
        }

        if (this.items.length === 0) {
            this.items.push(new QuickOpenItem({
                label: 'No tasks found',
                run: (_mode: QuickOpenMode): boolean => false
            }));
        }

        this.quickOpenService.open(this, {
            placeholder: 'Select a task to configure',
            fuzzyMatchLabel: true,
            fuzzySort: false
        });
    }

    onType(lookFor: string, acceptor: (items: QuickOpenItem[], actionProvider?: QuickOpenActionProvider) => void): void {
        acceptor(this.items, this.actionProvider);
    }

    protected getRunningTaskLabel(task: TaskInfo): string {
        return `Task id: ${task.taskId}, label: ${task.config.label}`;
    }

    private getFilteredTasks(recentTasks: TaskConfiguration[], configuredTasks: TaskConfiguration[], providedTasks: TaskConfiguration[])
        : { filteredRecentTasks: TaskConfiguration[], filteredConfiguredTasks: TaskConfiguration[], filteredProvidedTasks: TaskConfiguration[] } {

        const filteredRecentTasks: TaskConfiguration[] = [];
        recentTasks.forEach(recent => {
            const exist = [...configuredTasks, ...providedTasks].some(t => this.taskDefinitionRegistry.compareTasks(recent, t));
            if (exist) {
                filteredRecentTasks.push(recent);
            }
        });

        const filteredProvidedTasks: TaskConfiguration[] = [];
        providedTasks.forEach(provided => {
            const exist = [...filteredRecentTasks, ...configuredTasks].some(t => this.taskDefinitionRegistry.compareTasks(provided, t));
            if (!exist) {
                filteredProvidedTasks.push(provided);
            }
        });

        const filteredConfiguredTasks: TaskConfiguration[] = [];
        configuredTasks.forEach(configured => {
            const exist = filteredRecentTasks.some(t => this.taskDefinitionRegistry.compareTasks(configured, t));
            if (!exist) {
                filteredConfiguredTasks.push(configured);
            }
        });

        return {
            filteredRecentTasks, filteredConfiguredTasks, filteredProvidedTasks
        };
    }

    private getGroupedTasksByWorkspaceFolder(tasks: TaskConfiguration[]): Map<string | undefined, TaskConfiguration[]> {
        const grouped = new Map<string | undefined, TaskConfiguration[]>();
        for (const task of tasks) {
            const folder = task._scope;
            if (grouped.has(folder)) {
                grouped.get(folder)!.push(task);
            } else {
                grouped.set(folder, [task]);
            }
        }
        for (const taskConfigs of grouped.values()) {
            taskConfigs.sort((t1, t2) => t1.label.localeCompare(t2.label));
        }
        return grouped;
    }
}

export class TaskRunQuickOpenItem extends QuickOpenGroupItem {

    protected taskDefinitionRegistry: TaskDefinitionRegistry;

    constructor(
        protected readonly task: TaskConfiguration,
        protected taskService: TaskService,
        protected isMulti: boolean,
        protected readonly options: QuickOpenGroupItemOptions,
        protected readonly taskNameResolver: TaskNameResolver,
    ) {
        super(options);
    }

    getTask(): TaskConfiguration {
        return this.task;
    }

    getLabel(): string {
        return this.taskNameResolver.resolve(this.task);
    }

    getGroupLabel(): string {
        return this.options.groupLabel || '';
    }

    getDescription(): string {
        if (!this.isMulti) {
            return '';
        }
        if (this.taskDefinitionRegistry && !!this.taskDefinitionRegistry.getDefinition(this.task)) {
            if (this.task._scope) {
                return new URI(this.task._scope).displayName;
            }
            return this.task._source;
        } else {
            return new URI(this.task._source).displayName;
        }

    }

    run(mode: QuickOpenMode): boolean {
        if (mode !== QuickOpenMode.OPEN) {
            return false;
        }

        if (this.taskDefinitionRegistry && !!this.taskDefinitionRegistry.getDefinition(this.task)) {
            this.taskService.run(this.task.source, this.task.label);
        } else {
            this.taskService.run(this.task._source, this.task.label);
        }
        return true;
    }
}

export class TaskAttachQuickOpenItem extends QuickOpenItem {

    constructor(
        protected readonly task: TaskInfo,
        protected readonly taskLabel: string,
        protected taskService: TaskService
    ) {
        super();
    }

    getLabel(): string {
        return this.taskLabel!;
    }

    run(mode: QuickOpenMode): boolean {
        if (mode !== QuickOpenMode.OPEN) {
            return false;
        }
        if (this.task.terminalId) {
            this.taskService.attach(this.task.terminalId, this.task.taskId);
        }
        return true;
    }
}
export class TaskConfigureQuickOpenItem extends QuickOpenGroupItem {

    protected taskDefinitionRegistry: TaskDefinitionRegistry;

    constructor(
        protected readonly task: TaskConfiguration,
        protected readonly taskService: TaskService,
        protected readonly taskNameResolver: TaskNameResolver,
        protected readonly workspaceService: WorkspaceService,
        protected readonly isMulti: boolean,
        protected readonly options: QuickOpenGroupItemOptions
    ) {
        super(options);
        const stat = this.workspaceService.workspace;
        this.isMulti = stat ? !stat.isDirectory : false;
    }

    getLabel(): string {
        return this.taskNameResolver.resolve(this.task);
    }

    getGroupLabel(): string {
        return this.options.groupLabel || '';
    }

    getDescription(): string {
        if (!this.isMulti) {
            return '';
        }
        if (this.taskDefinitionRegistry && !!this.taskDefinitionRegistry.getDefinition(this.task)) {
            if (this.task._scope) {
                return new URI(this.task._scope).displayName;
            }
            return this.task._source;
        } else {
            return new URI(this.task._source).displayName;
        }
    }

    run(mode: QuickOpenMode): boolean {
        if (mode !== QuickOpenMode.OPEN) {
            return false;
        }
        this.taskService.configure(this.task);

        return true;
    }
}

@injectable()
export class TaskTerminateQuickOpen implements QuickOpenModel {

    @inject(QuickOpenService)
    protected readonly quickOpenService: QuickOpenService;

    @inject(TaskService)
    protected readonly taskService: TaskService;

    async onType(_lookFor: string, acceptor: (items: QuickOpenItem[]) => void): Promise<void> {
        const items: QuickOpenItem[] = [];
        const runningTasks: TaskInfo[] = await this.taskService.getRunningTasks();
        if (runningTasks.length <= 0) {
            items.push(new QuickOpenItem({
                label: 'No task is currently running',
                run: (): boolean => false,
            }));
        } else {
            runningTasks.forEach((task: TaskInfo) => {
                items.push(new QuickOpenItem({
                    label: task.config.label,
                    run: (mode: QuickOpenMode): boolean => {
                        if (mode !== QuickOpenMode.OPEN) {
                            return false;
                        }
                        this.taskService.kill(task.taskId);
                        return true;
                    }
                }));
            });
            if (runningTasks.length > 1) {
                items.push(new QuickOpenItem({
                    label: 'All running tasks',
                    run: (mode: QuickOpenMode): boolean => {
                        if (mode !== QuickOpenMode.OPEN) {
                            return false;
                        }
                        runningTasks.forEach((t: TaskInfo) => {
                            this.taskService.kill(t.taskId);
                        });
                        return true;
                    }
                }));
            }
        }
        acceptor(items);
    }

    async open(): Promise<void> {
        this.quickOpenService.open(this, {
            placeholder: 'Select task to terminate',
            fuzzyMatchLabel: true,
            fuzzyMatchDescription: true,
        });
    }

}

@injectable()
export class TaskRunningQuickOpen implements QuickOpenModel {

    @inject(QuickOpenService)
    protected readonly quickOpenService: QuickOpenService;

    @inject(TaskService)
    protected readonly taskService: TaskService;

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    async onType(_lookFor: string, acceptor: (items: QuickOpenItem[]) => void): Promise<void> {
        const items: QuickOpenItem[] = [];
        const runningTasks: TaskInfo[] = await this.taskService.getRunningTasks();
        if (runningTasks.length <= 0) {
            items.push(new QuickOpenItem({
                label: 'No task is currently running',
                run: (): boolean => false,
            }));
        } else {
            runningTasks.forEach((task: TaskInfo) => {
                items.push(new QuickOpenItem({
                    label: task.config.label,
                    run: (mode: QuickOpenMode): boolean => {
                        if (mode !== QuickOpenMode.OPEN) {
                            return false;
                        }
                        if (task.terminalId) {
                            const terminal = this.terminalService.getById('terminal-' + task.terminalId);
                            if (terminal) {
                                this.terminalService.open(terminal);
                            }
                        }
                        return true;
                    }
                }));
            });
        }
        acceptor(items);
    }

    async open(): Promise<void> {
        this.quickOpenService.open(this, {
            placeholder: 'Select the task to show its output',
            fuzzyMatchLabel: true,
            fuzzyMatchDescription: true,
        });
    }
}
