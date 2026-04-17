import React, { useState, useCallback, useEffect } from 'react';
import {
  ListTodo,
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Eye,
  Hand,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { api, type WatchedRepo } from '../../lib/api';
import { isAgentTask, type TaskType, type TaskPriority } from '@fastowl/shared';

interface CreateTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const typeOptions: {
  value: TaskType;
  label: string;
  icon: React.ElementType;
  description: string;
  promptPlaceholder: string;
}[] = [
  {
    value: 'code_writing',
    label: 'Code',
    icon: Sparkles,
    description: 'Claude writes code: features, bug fixes, refactors.',
    promptPlaceholder:
      'e.g., Fix the authentication bug where users are logged out after refreshing the page...',
  },
  {
    value: 'pr_response',
    label: 'PR Response',
    icon: MessageSquare,
    description: 'Respond to review comments on one of your PRs.',
    promptPlaceholder:
      'e.g., Address the review comments on PR #234 — rename variables as suggested and add tests...',
  },
  {
    value: 'pr_review',
    label: 'PR Review',
    icon: Eye,
    description: "Draft review comments for someone else's PR.",
    promptPlaceholder:
      "e.g., Review PR #567 — focus on error handling and the new migration...",
  },
  {
    value: 'manual',
    label: 'Manual',
    icon: Hand,
    description: 'A task you handle yourself (no agent).',
    promptPlaceholder: '',
  },
];

export function CreateTaskModal({ open, onOpenChange }: CreateTaskModalProps) {
  const { environments, currentWorkspaceId } = useWorkspaceStore();
  const { createTask } = useTaskActions();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TaskType>('code_writing');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [prompt, setPrompt] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<WatchedRepo[]>([]);

  const connectedEnvironments = environments.filter((e) => e.status === 'connected');
  const typeConfig = typeOptions.find((t) => t.value === type)!;
  const isAgent = isAgentTask(type);

  // Load repositories when modal opens
  useEffect(() => {
    if (open && currentWorkspaceId) {
      api.repositories.list(currentWorkspaceId).then(setRepositories).catch(console.error);
    }
  }, [open, currentWorkspaceId]);

  // Auto-generate metadata when prompt changes (debounced)
  useEffect(() => {
    if (!prompt || prompt.length < 10 || !isAgent) return;
    if (title && description) return; // Don't override if user has already entered values

    const timer = setTimeout(async () => {
      setIsGenerating(true);
      try {
        const metadata = await api.tasks.generateMetadata(prompt);
        if (!title) setTitle(metadata.title);
        if (!description) setDescription(metadata.description);
        setPriority(metadata.suggestedPriority);
      } catch (err) {
        console.error('Failed to generate metadata:', err);
      } finally {
        setIsGenerating(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [prompt, isAgent, title, description]);

  const handleSubmit = useCallback(async () => {
    const effectiveTitle = title || (prompt ? prompt.slice(0, 60) : '');
    const effectiveDescription = description || prompt || '';

    if (!effectiveTitle || !effectiveDescription || !currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      await createTask({
        workspaceId: currentWorkspaceId,
        title: effectiveTitle,
        description: effectiveDescription,
        type,
        priority,
        prompt: isAgent ? prompt || undefined : undefined,
        repositoryId: isAgent && repositoryId ? repositoryId : undefined,
        assignedEnvironmentId: isAgent && environmentId ? environmentId : undefined,
      });
      onOpenChange(false);
      setTitle('');
      setDescription('');
      setType('code_writing');
      setPriority('medium');
      setPrompt('');
      setRepositoryId('');
      setEnvironmentId('');
      setShowAdvanced(false);
    } catch (err: any) {
      setError(err.message || 'Failed to create task');
    } finally {
      setIsLoading(false);
    }
  }, [title, description, type, priority, prompt, repositoryId, environmentId, currentWorkspaceId, createTask, onOpenChange, isAgent]);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      setError(null);
      setShowAdvanced(false);
    }
  }, [isLoading, onOpenChange]);

  const isValid = isAgent
    ? prompt.length > 0
    : title && description;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodo className="w-5 h-5" />
            Create New Task
          </DialogTitle>
          <DialogDescription>{typeConfig.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Task Type Picker */}
          <div className="grid grid-cols-2 gap-2">
            {typeOptions.map((opt) => {
              const Icon = opt.icon;
              const selected = type === opt.value;
              return (
                <Button
                  key={opt.value}
                  type="button"
                  variant={selected ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setType(opt.value)}
                  disabled={isLoading}
                  className="justify-start"
                >
                  <Icon className="w-4 h-4 mr-2" />
                  {opt.label}
                </Button>
              );
            })}
          </div>

          {isAgent ? (
            <>
              <Textarea
                label="What do you want Claude to do?"
                placeholder={typeConfig.promptPlaceholder}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isLoading}
                rows={4}
              />

              {repositories.length > 0 && (
                <Select
                  label="Repository"
                  value={repositoryId}
                  onChange={(e) => setRepositoryId(e.target.value)}
                  disabled={isLoading}
                >
                  <option value="">Select a repository...</option>
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </option>
                  ))}
                </Select>
              )}

              {(title || description || isGenerating) && (
                <div className="p-3 rounded-md bg-secondary/50 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Generating title & description...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3" />
                        Auto-generated (click to edit)
                      </>
                    )}
                  </div>
                  {title && (
                    <Input
                      label="Title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      disabled={isLoading}
                      className="text-sm"
                    />
                  )}
                  {description && (
                    <Textarea
                      label="Description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      disabled={isLoading}
                      rows={2}
                      className="text-sm"
                    />
                  )}
                </div>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-between"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                Advanced options
                {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>

              {showAdvanced && (
                <div className="space-y-4 pl-2 border-l-2 border-muted">
                  <div className="grid grid-cols-2 gap-4">
                    <Select
                      label="Priority"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as TaskPriority)}
                      disabled={isLoading}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </Select>

                    <Select
                      label="Environment"
                      value={environmentId}
                      onChange={(e) => setEnvironmentId(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">Any available</option>
                      {connectedEnvironments.map((env) => (
                        <option key={env.id} value={env.id}>
                          {env.name} ({env.type})
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <Input
                label="Title"
                placeholder="e.g., Review PR #123"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isLoading}
              />

              <Textarea
                label="Description"
                placeholder="Describe what needs to be done..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isLoading}
                rows={3}
              />

              <Select
                label="Priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                disabled={isLoading}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </>
          )}

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <ListTodo className="w-4 h-4 mr-2" />
                Create Task
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
