import React, { useState, useCallback } from 'react';
import { ListTodo, Loader2 } from 'lucide-react';
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
  const [environmentId, setEnvironmentId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedEnvironments = environments.filter((e) => e.status === 'connected');

  const handleSubmit = useCallback(async () => {
    if (!title || !description || !currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      await createTask({
        workspaceId: currentWorkspaceId,
        title,
        description,
        type,
        priority,
        prompt: type === 'automated' ? prompt || undefined : undefined,
        assignedEnvironmentId: type === 'automated' && environmentId ? environmentId : undefined,
      });
      onOpenChange(false);
      // Reset form
      setTitle('');
      setDescription('');
      setType('automated');
      setPriority('medium');
      setPrompt('');
      setEnvironmentId('');
    } catch (err: any) {
      setError(err.message || 'Failed to create task');
    } finally {
      setIsLoading(false);
    }
  }, [title, description, type, priority, prompt, environmentId, currentWorkspaceId, createTask, onOpenChange]);

  const handleClose = useCallback(() => {
    if (!isLoading) {
      onOpenChange(false);
      setError(null);
    }
  }, [isLoading, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={handleClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodo className="w-5 h-5" />
            Create New Task
          </DialogTitle>
          <DialogDescription>
            Add a task to the queue. Automated tasks will be assigned to available agents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Input
            label="Title"
            placeholder="e.g., Fix authentication bug"
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

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as TaskType)}
              disabled={isLoading}
            >
              <option value="automated">Automated (Agent)</option>
              <option value="manual">Manual (Human)</option>
            </Select>

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
          </div>

          {type === 'automated' && (
            <>
              <Textarea
                label="Agent Prompt"
                placeholder="Instructions for the Claude agent..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isLoading}
                rows={4}
              />

              <Select
                label="Preferred Environment (optional)"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                disabled={isLoading}
              >
                <option value="">Any available environment</option>
                {connectedEnvironments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.type})
                  </option>
                ))}
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
            disabled={!title || !description || isLoading}
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
