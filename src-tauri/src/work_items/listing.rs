use super::{
    fake::{InMemoryWorkItemProvider, WorkItemError},
    model::*,
    protocol::*,
};

impl InMemoryWorkItemProvider {
    pub fn list(&self, query: &WorkItemQuery) -> Result<WorkItemPage, WorkItemError> {
        if !(1..=100).contains(&query.limit) {
            return Err(WorkItemError::Query("limit must be 1..100".into()));
        }
        let mut effective = query.clone();
        if let Some(id) = &query.saved_filter_id {
            let preset = self
                .saved_filters
                .iter()
                .find(|p| &p.id == id)
                .ok_or_else(|| WorkItemError::Query("unknown saved filter".into()))?;
            effective.filters.splice(0..0, preset.query.filters.clone());
            if effective.search.is_empty() {
                effective.search.clone_from(&preset.query.search);
            }
            if effective.sort.is_none() {
                effective.sort.clone_from(&preset.query.sort);
            }
        }
        for filter in &effective.filters {
            let schema = self
                .fields
                .iter()
                .find(|s| s.id == filter.field_id)
                .ok_or_else(|| WorkItemError::Query("unknown filter field".into()))?;
            for value in &filter.values {
                super::validation::validate_value(schema, Some(value))
                    .map_err(WorkItemError::Query)?;
            }
        }
        if effective
            .sort
            .as_ref()
            .is_some_and(|s| !matches!(s.field_id.as_str(), "key" | "title" | "updatedAt"))
        {
            return Err(WorkItemError::Query(
                "fake supports key/title/updatedAt sort".into(),
            ));
        }
        effective.cursor = None;
        let fingerprint =
            serde_json::to_string(&effective).map_err(|e| WorkItemError::Query(e.to_string()))?;
        let offset = if let Some(cursor) = &query.cursor {
            let (revision, offset, signature): (u64, usize, String) = serde_json::from_str(cursor)
                .map_err(|_| WorkItemError::Query("invalid cursor".into()))?;
            if revision != self.revision || signature != fingerprint {
                return Err(WorkItemError::Query(
                    "stale or different-query cursor".into(),
                ));
            }
            offset
        } else {
            0
        };
        let search = effective.search.to_lowercase();
        let mut items: Vec<_> = self
            .items
            .values()
            .filter(|d| {
                (search.is_empty()
                    || format!("{} {} {}", d.item.key, d.item.title, d.body)
                        .to_lowercase()
                        .contains(&search))
                    && effective.filters.iter().all(|f| {
                        let actual = d.item.fields.get(&f.field_id).and_then(Option::as_ref);
                        if f.values.is_empty() {
                            actual.is_none()
                        } else {
                            f.values
                                .iter()
                                .any(|value| super::validation::matches_filter(actual, value))
                        }
                    })
            })
            .map(|d| d.item.clone())
            .collect();
        if let Some(sort) = &effective.sort {
            items.sort_by(|a, b| {
                let key = |i: &WorkItem| match sort.field_id.as_str() {
                    "title" => i.title.clone(),
                    "updatedAt" => i.updated_at.clone(),
                    _ => i.key.clone(),
                };
                let order = key(a).cmp(&key(b));
                (if sort.descending {
                    order.reverse()
                } else {
                    order
                })
                .then(a.reference.cmp(&b.reference))
            });
        }
        if offset > items.len() {
            return Err(WorkItemError::Query("cursor beyond result".into()));
        }
        let end = offset.saturating_add(query.limit as usize).min(items.len());
        let next_cursor = if end < items.len() {
            Some(
                serde_json::to_string(&(self.revision, end, fingerprint))
                    .map_err(|e| WorkItemError::Query(e.to_string()))?,
            )
        } else {
            None
        };
        Ok(WorkItemPage {
            items: items[offset..end].to_vec(),
            next_cursor,
            total: u32::try_from(items.len()).ok(),
        })
    }

    pub fn comments(
        &self,
        reference: &WorkItemRef,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<WorkItemCommentPage, WorkItemError> {
        if !(1..=100).contains(&limit) {
            return Err(WorkItemError::Query("limit must be 1..100".into()));
        }
        let detail = self.detail(reference)?;
        let signature = format!(
            "comments:{}",
            serde_json::to_string(reference).map_err(|e| WorkItemError::Query(e.to_string()))?
        );
        let offset = if let Some(cursor) = cursor {
            let (revision, offset, scope): (u64, usize, String) = serde_json::from_str(cursor)
                .map_err(|_| WorkItemError::Query("invalid comment cursor".into()))?;
            if revision != self.revision || scope != signature {
                return Err(WorkItemError::Query(
                    "stale or different-item comment cursor".into(),
                ));
            }
            offset
        } else {
            0
        };
        let entries = detail.comments.entries;
        if offset > entries.len() {
            return Err(WorkItemError::Query("comment cursor beyond result".into()));
        }
        let end = offset.saturating_add(limit as usize).min(entries.len());
        let next_cursor = if end < entries.len() {
            Some(
                serde_json::to_string(&(self.revision, end, signature))
                    .map_err(|e| WorkItemError::Query(e.to_string()))?,
            )
        } else {
            None
        };
        Ok(WorkItemCommentPage {
            entries: entries[offset..end].to_vec(),
            next_cursor,
        })
    }
}
