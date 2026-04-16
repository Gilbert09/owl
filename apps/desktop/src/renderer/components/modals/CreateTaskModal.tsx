import React, { useState, useCallback, useEffect } from 'react';
import { ListTodo, Loader2, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
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
import type { TaskType, TaskPriority } from '@fastowl/shared';

interface CreateTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTaskModal({ open, onOpenChange }: CreateTaskModalProps) {
  const { environments, currentWorkspaceId } = useWorkspaceStore();
  const { createTask } = useTaskActions();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TaskType>('automated');
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

  // Load repositories when modal opens
  useEffect(() => {
    if (open && currentWorkspaceId) {
      api.repositories.list(currentWorkspaceId).then(setRepositories).catch(console.error);
    }
  }, [open, currentWorkspaceId]);

  // Auto-generate metadata when prompt changes (debounced)
  useEffect(() => {
    if (!prompt || prompt.length < 10 || type !== 'automated') return;
    if (title && description) return; // Don't override if user has already entered values

    const timer = setTimeout(async () => {
      setIsGenerating(true);
      try {
        const metadata = await api.tasks.generateMetadata(prompt);
        // Only set if user hasn't entered values
        if (!title) setTitle(metadata.title);
        if (!description) setDescription(metadata.description);
        setPriority(metadata.suggestedPriority);
      } catch (err) {
        // Silently fail - not critical
        console.error('Failed to generate metadata:', err);
      } finally {
        setIsGenerating(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [prompt, type, title, description]);

  const handleSubmit = useCallback(async () => {
    // For automated tasks, prompt is required; title/description can be auto-generated
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
        prompt: type === 'automated' ? prompt || undefined : undefined,
        repositoryId: type === 'automated' && repositoryId ? repositoryId : undefined,
        assignedEnvironmentId: type === 'automated' && environmentId ? environmentId : undefined,
      });
      onOpenChange(false);
      // Reset form
      setTitle('');
      setDescription('');
      setType('automated');
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
  }, [title, description, type, priority, prompt, repositoryId, environmentId, currentWorkspaceId, createTask, onOpenChange]);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      setError(null);
      setShowAdvanced(false);
    }
  }, [isLoading, onOpenChange]);

  // Check if form is valid
  const isValid = type === 'automated'
    ? prompt.length > 0 // For automated tasks, just need a prompt
    : title && description; // For manual tasks, need title and description

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodo className="w-5 h-5" />
            Create New Task
          </DialogTitle>
          <DialogDescription>
            {type === 'automated'
              ? 'Enter a prompt and Claude will handle the task. Title and description will be auto-generated.'
              : 'Add a manual task that requires human action.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Task Type Toggle */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant={type === 'automated' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setType('automated')}
              disabled={isLoading}
            >
              <Sparkles className="w-4 h-4 mr-1" />
              Automated (Agent)
            </Button>
            <Button
              type="button"
              variant={type === 'manual' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setType('manual')}
              disabled={isLoading}
            >
              Manual (Human)
            </Button>
          </div>

          {type === 'automated' ? (
            <>
              {/* Prompt is primary for automated tasks */}
              <Textarea
                label="What do you want Claude to do?"
                placeholder="e.g., Fix the authentication bug where users are logged out after refreshing the page..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isLoading}
                rows={4}
              />

              {/* Repository selector */}
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

              {/* Auto-generated metadata display */}
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

              {/* Advanced options toggle */}
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
              {/* Manual task: traditional title/description form */}
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
