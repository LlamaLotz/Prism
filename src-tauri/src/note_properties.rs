//! Read-only projection of file-owned frontmatter. Invalid YAML never modifies a note.
use serde_yaml::Value;
pub fn list(content: &str, key: &str) -> Vec<String> {
    let content = content.trim_start_matches('\u{feff}');
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return vec![];
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        if yaml.len() > 256 * 1024 {
            return vec![];
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed {
        return vec![];
    }
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(&yaml) else {
        return vec![];
    };
    let value = map.get(Value::String(key.into())).or_else(|| {
        if key == "aliases" {
            map.get(Value::String("alias".into()))
        } else {
            None
        }
    });
    let items: Vec<String> = match value {
        Some(Value::String(v)) => vec![v.clone()],
        Some(Value::Sequence(v)) => v
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => vec![],
    };
    let mut result = vec![];
    for item in items {
        let item = item.trim().to_owned();
        if !item.is_empty() && !result.contains(&item) {
            result.push(item);
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoted_lists() {
        assert_eq!(
            list(
                "---\naliases: [\"Research, notes\", 'தமிழ்']\n---\nBody",
                "aliases"
            ),
            vec!["Research, notes", "தமிழ்"]
        );
        assert_eq!(
            list(
                "---\r\ntags:\r\n  - research\r\n  - science\r\n---\r\n",
                "tags"
            ),
            vec!["research", "science"]
        );
    }
    #[test]
    fn invalid_is_not_repaired() {
        assert!(list("---\ntags: [oops\n---", "tags").is_empty());
        assert!(list("---\ntags: a\ntags: b\n---", "tags").is_empty());
    }
}

#[cfg(test)]
mod index_tests {
    #[test]
    fn properties_and_inline_tags_share_the_existing_projection() {
        let db = crate::db::Database::open(":memory:").unwrap();
        crate::db::upsert_note(&db.conn, "note", "Note", "/vault/note.md", &[]).unwrap();
        crate::db::sync_note_tags(
            &db.conn,
            "note",
            "---\ntags: [research, science]\n---\n@research @legacy user@example.com",
        )
        .unwrap();
        let groups = crate::db::get_topic_groups(&db.conn).unwrap();
        assert_eq!(
            groups.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(),
            vec!["legacy", "research", "science"]
        );
        crate::db::sync_note_tags(&db.conn, "note", "---\ntags: []\n---\n@research @legacy")
            .unwrap();
        let groups = crate::db::get_topic_groups(&db.conn).unwrap();
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().any(|g| g.0 == "research"));
    }
}
