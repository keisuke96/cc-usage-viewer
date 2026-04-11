import type { Session } from '@ccuv/shared';
import GroupsIcon from '@mui/icons-material/Groups';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  List,
  ListItemButton,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { LoadedSessionDocument } from '../lib/session-document';

import {
  collectSessionDocumentFilePaths,
  loadSessionDocument,
  resolveSessionDocumentPlan,
  resolveSessionDocumentSectionLabel,
  sessionDisplayLabel,
} from '../lib/session-document';
import { fetchProjects, fetchSessions } from '../lib/api';
import { downloadSessionExportHtmlClient } from '../lib/session-export';
import { SessionDocument } from './SessionDocument';

function renderTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '';
  }

  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    if (diffDay < 7) return `${diffDay}日前`;
    return date.toLocaleDateString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

export function App() {
  const [selectedSectionTab, setSelectedSectionTab] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionFile, setSelectedSessionFile] = useState<string | null>(null);
  const [showEmptyProjects, setShowEmptyProjects] = useState(false);
  const [showEmptySessions, setShowEmptySessions] = useState(false);
  const [isExportingHtml, setIsExportingHtml] = useState(false);

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  const projects = projectsQuery.data ?? [];

  const visibleProjects = useMemo(
    () => (showEmptyProjects ? projects : projects.filter((project) => project.session_count > 0)),
    [projects, showEmptyProjects],
  );

  const hiddenProjectCount = useMemo(
    () => projects.filter((project) => project.session_count === 0).length,
    [projects],
  );

  useEffect(() => {
    if (!selectedProjectId && visibleProjects.length > 0) {
      setSelectedProjectId(visibleProjects[0].id);
    }
  }, [selectedProjectId, visibleProjects]);

  const sessionsQuery = useQuery({
    queryKey: ['sessions', selectedProjectId],
    queryFn: () => fetchSessions(selectedProjectId ?? ''),
    enabled: selectedProjectId !== null,
  });

  const sessions = sessionsQuery.data ?? [];

  const visibleSessions = useMemo(
    () => (showEmptySessions ? sessions : sessions.filter((session) => session.first_message)),
    [sessions, showEmptySessions],
  );

  const hiddenSessionCount = useMemo(
    () => sessions.filter((session) => !session.first_message).length,
    [sessions],
  );

  useEffect(() => {
    if (!sessions.length) {
      setSelectedSessionFile(null);
      return;
    }

    const allSessionFiles = collectSessionDocumentFilePaths(sessions);
    if (!selectedSessionFile || !allSessionFiles.has(selectedSessionFile)) {
      setSelectedSessionFile(sessions[0].jsonl_path);
    }
  }, [selectedSessionFile, sessions]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const selectedDocumentPlan = useMemo(
    () =>
      selectedSessionFile ? resolveSessionDocumentPlan(sessions, selectedSessionFile) : null,
    [selectedSessionFile, sessions],
  );

  const selectedSessionLabel = useMemo(
    () => resolveSessionDocumentSectionLabel(sessions, selectedSessionFile),
    [selectedSessionFile, sessions],
  );

  useEffect(() => {
    setSelectedSectionTab(0);
  }, [selectedSessionFile]);

  const documentQuery = useQuery({
    queryKey: [
      'session-document',
      selectedDocumentPlan?.sections.map((section) => section.filePath).join('|') ?? '',
    ],
    queryFn: () => loadSessionDocument(selectedDocumentPlan as NonNullable<typeof selectedDocumentPlan>),
    enabled: selectedDocumentPlan !== null,
  });

  const filteredDocument = useMemo((): LoadedSessionDocument | null => {
    if (!documentQuery.data) return null;
    const section =
      documentQuery.data.sections[selectedSectionTab] ?? documentQuery.data.sections[0];
    if (!section) return documentQuery.data;
    return { ...documentQuery.data, sections: [section] };
  }, [documentQuery.data, selectedSectionTab]);

  async function handleExportHtml(): Promise<void> {
    if (!selectedDocumentPlan || !documentQuery.data || isExportingHtml) {
      return;
    }

    try {
      setIsExportingHtml(true);
      await downloadSessionExportHtmlClient({
        projectName: selectedProject?.display_name ?? selectedProjectId ?? 'project',
        document: documentQuery.data,
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'HTML export に失敗しました。');
    } finally {
      setIsExportingHtml(false);
    }
  }

  const rightPaneTitle =
    documentQuery.data?.title ?? selectedDocumentPlan?.title ?? selectedSessionLabel ?? 'Document';
  const rightPaneSubtitle = documentQuery.data
    ? documentQuery.data.sections.length > 1
      ? `${documentQuery.data.sections.length} sections`
      : null
    : null;

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        color: 'text.primary',
        overflow: 'hidden',
      }}
    >
      <Stack direction="row" spacing={0} sx={{ flex: 1, overflow: 'hidden' }}>
        <Box
          sx={{
            width: 240,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'rgba(0,0,0,0.25)',
          }}
        >
          <Box
            sx={{
              px: 2,
              py: 1.25,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontWeight: 600, color: 'text.secondary', letterSpacing: 0.3 }}
            >
              プロジェクト
            </Typography>
            {hiddenProjectCount > 0 && (
              <Button
                size="small"
                onClick={() => setShowEmptyProjects((value) => !value)}
                sx={{ fontSize: 11, py: 0, minWidth: 0, color: 'primary.main' }}
              >
                {showEmptyProjects ? '空を非表示' : '空を表示'}
              </Button>
            )}
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {projectsQuery.isLoading ? (
              <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
                <CircularProgress size={20} />
              </Box>
            ) : projectsQuery.error ? (
              <Alert severity="error" sx={{ m: 1, fontSize: 12 }}>
                {(projectsQuery.error as Error).message}
              </Alert>
            ) : (
              <>
                <List dense disablePadding>
                  {visibleProjects.map((project) => {
                    const isSelected = project.id === selectedProjectId;
                    return (
                      <ListItemButton
                        key={project.id}
                        selected={isSelected}
                        onClick={() => {
                          setSelectedProjectId(project.id);
                        }}
                        sx={{
                          py: 1,
                          px: 2,
                          borderLeft: 3,
                          borderColor: isSelected ? 'primary.main' : 'transparent',
                        }}
                      >
                        <Box>
                          <Typography
                            sx={{
                              fontSize: 13,
                              fontWeight: isSelected ? 700 : 400,
                              lineHeight: 1.3,
                            }}
                          >
                            {project.display_name}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ color: 'text.secondary', fontSize: 11 }}
                          >
                            {project.session_count} sessions
                          </Typography>
                        </Box>
                      </ListItemButton>
                    );
                  })}
                </List>
                {!showEmptyProjects && hiddenProjectCount > 0 && (
                  <Box sx={{ px: 2, py: 1 }}>
                    <Typography
                      variant="caption"
                      sx={{ color: 'text.disabled', fontSize: 11, cursor: 'pointer' }}
                      onClick={() => setShowEmptyProjects(true)}
                    >
                      {hiddenProjectCount} 件のセッションなしのプロジェクトを非表示
                    </Typography>
                  </Box>
                )}
              </>
            )}
          </Box>
        </Box>

        <Box
          sx={{
            width: 300,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            bgcolor: 'background.paper',
          }}
        >
          <Box
            sx={{
              px: 2,
              py: 1.25,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 40,
            }}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {selectedProject
                ? `${selectedProject.display_name} (${selectedProject.session_count})`
                : 'Sessions'}
            </Typography>
            {hiddenSessionCount > 0 && (
              <Button
                size="small"
                onClick={() => setShowEmptySessions((value) => !value)}
                sx={{ fontSize: 11, py: 0, minWidth: 0, color: 'primary.main' }}
              >
                {showEmptySessions ? '空を非表示' : '空を表示'}
              </Button>
            )}
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {sessionsQuery.isLoading ? (
              <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
                <CircularProgress size={20} />
              </Box>
            ) : sessionsQuery.error ? (
              <Alert severity="error" sx={{ m: 1, fontSize: 12 }}>
                {(sessionsQuery.error as Error).message}
              </Alert>
            ) : (
              <List dense disablePadding>
                {visibleSessions.map((session) => (
                  <ListItemButton
                    key={session.session_id}
                    selected={session.jsonl_path === selectedSessionFile}
                    onClick={() => {
                      setSelectedSessionFile(session.jsonl_path);
                    }}
                    sx={{
                      py: 1,
                      px: 2,
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      borderBottom: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography
                      sx={{
                        fontSize: 13,
                        fontWeight: session.jsonl_path === selectedSessionFile ? 600 : 400,
                        width: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        lineHeight: 1.4,
                      }}
                    >
                      {sessionDisplayLabel(session)}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
                        {renderTimestamp(session.timestamp)}
                      </Typography>
                      {session.subagents.length > 0 && (
                        <Chip
                          icon={<SmartToyIcon sx={{ fontSize: '11px !important' }} />}
                          label={session.subagents.length}
                          size="small"
                          sx={{
                            height: 16,
                            fontSize: 10,
                            '& .MuiChip-label': { px: 0.5 },
                            '& .MuiChip-icon': { ml: 0.5 },
                          }}
                        />
                      )}
                      {session.team_sessions.length > 0 && (
                        <Chip
                          icon={<GroupsIcon sx={{ fontSize: '11px !important' }} />}
                          label={session.team_sessions.length}
                          size="small"
                          sx={{
                            height: 16,
                            fontSize: 10,
                            '& .MuiChip-label': { px: 0.5 },
                            '& .MuiChip-icon': { ml: 0.5 },
                          }}
                        />
                      )}
                    </Box>
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
        </Box>

        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!selectedSessionFile ? (
            <Box sx={{ p: 3 }}>
              <Typography color="text.secondary">セッションを選択してください。</Typography>
            </Box>
          ) : documentQuery.isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress size={28} />
            </Box>
          ) : documentQuery.error ? (
            <Box sx={{ p: 3 }}>
              <Alert severity="error">{(documentQuery.error as Error).message}</Alert>
            </Box>
          ) : !documentQuery.data || !filteredDocument ? (
            <Box sx={{ p: 3 }}>
              <Typography color="text.secondary">document を読み込めませんでした。</Typography>
            </Box>
          ) : (
            <>
              <Box sx={{ px: 3, py: 1.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{rightPaneTitle}</Typography>
                    {rightPaneSubtitle && (
                      <Typography color="text.secondary" sx={{ fontSize: 12 }}>
                        {rightPaneSubtitle}
                      </Typography>
                    )}
                  </Box>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      void handleExportHtml();
                    }}
                    disabled={isExportingHtml}
                    sx={{ flexShrink: 0 }}
                  >
                    {isExportingHtml ? 'Exporting…' : 'HTML Export'}
                  </Button>
                </Box>
              </Box>

              {documentQuery.data.sections.length > 1 && (
                <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
                  <Tabs
                    value={selectedSectionTab}
                    onChange={(_, value: number) => setSelectedSectionTab(value)}
                    sx={{ minHeight: 36 }}
                    variant="scrollable"
                    scrollButtons="auto"
                  >
                    {documentQuery.data.sections.map((section, index) => (
                      <Tab
                        key={section.filePath}
                        label={
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {section.kind === 'team' ? (
                              <GroupsIcon sx={{ fontSize: 13 }} />
                            ) : section.kind === 'subagent' ? (
                              <SmartToyIcon sx={{ fontSize: 13 }} />
                            ) : null}
                            <span>{section.title}</span>
                          </Box>
                        }
                        value={index}
                        sx={{ minHeight: 36, py: 0, fontSize: 12 }}
                      />
                    ))}
                  </Tabs>
                </Box>
              )}

              <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 2 }}>
                <SessionDocument
                  document={filteredDocument}
                  mode="interactive"
                  view="both"
                  selectedFilePath={filteredDocument.sections[0]?.filePath}
                />
              </Box>
            </>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
