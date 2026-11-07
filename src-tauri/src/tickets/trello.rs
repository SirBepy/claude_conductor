//! Trello's client: a card fetch keyed by board short link plus card number, and
//! the guards that keep an id out of a URL path unless it is plain.

use super::{env_token, http, token_for, TicketSummary, TrackerKind};

/// Trello authenticates with an API key AND a user token, so it has a second
/// secret `token_for` cannot return.
fn trello_token() -> Result<String, String> {
    env_token("TRELLO_TOKEN").ok_or_else(|| "TRELLO_TOKEN is not set in ~/.claude/.env".to_string())
}

/// A board short link, card short link or card number goes straight into a URL
/// path, so anything beyond these characters is refused rather than escaped.
fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `tr-12` -> the board-relative card path, else a card short link -> the card path.
pub(super) fn trello_card_path(workspace: &str, id: &str) -> Result<String, String> {
    if !safe_segment(id) {
        return Err(format!("bad card id {id}"));
    }
    match id.to_ascii_lowercase().strip_prefix("tr-") {
        Some(n) if n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty() => {
            if !safe_segment(workspace) {
                return Err("set the Trello board id in project settings".into());
            }
            Ok(format!("boards/{workspace}/cards/{n}"))
        }
        Some(_) => Err(format!("bad card id {id}")),
        None => Ok(format!("cards/{id}")),
    }
}

// Fields trimmed to what the hover card shows; `list` and `members` expand the
// two ids a card otherwise carries into names.
const TRELLO_CARD_QUERY: &str =
    "fields=name,idShort,shortUrl,labels&list=true&list_fields=name&members=true&member_fields=fullName";

pub(super) async fn trello_get(path: &str) -> Result<serde_json::Value, String> {
    let key = token_for(TrackerKind::Trello)?;
    let token = trello_token()?;
    // Header auth keeps the token out of the URL, so it cannot land in a log line.
    let resp = http()
        .get(format!("https://api.trello.com/1/{path}?{TRELLO_CARD_QUERY}"))
        .header("Authorization", format!("OAuth oauth_consumer_key=\"{key}\", oauth_token=\"{token}\""))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Trello returned {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

pub(super) fn trello_summary(card: &serde_json::Value) -> Result<TicketSummary, String> {
    let number = card["idShort"].as_i64().ok_or("card has no number")?;
    // A label may carry only a colour; fall back to it so a card still shows a type.
    let label = card["labels"].as_array().and_then(|l| l.first()).and_then(|l| {
        l["name"].as_str().filter(|n| !n.is_empty()).or_else(|| l["color"].as_str())
    });
    Ok(TicketSummary {
        id: format!("tr-{number}"),
        title: card["name"].as_str().unwrap_or_default().to_string(),
        state: card.pointer("/list/name").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
        owner: card.pointer("/members/0/fullName").and_then(|m| m.as_str()).map(str::to_string),
        ticket_type: label.unwrap_or("card").to_string(),
        url: card["shortUrl"].as_str().unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{prompt_line, TicketTracker};
    use super::*;

    #[test]
    fn trello_card_path_uses_the_board_for_a_number_and_the_card_for_a_short_link() {
        assert_eq!(trello_card_path("AbCd1234", "tr-12").unwrap(), "boards/AbCd1234/cards/12");
        assert_eq!(trello_card_path("AbCd1234", "TR-7").unwrap(), "boards/AbCd1234/cards/7");
        assert_eq!(trello_card_path("", "Xy12Zq90").unwrap(), "cards/Xy12Zq90");
        assert!(trello_card_path("", "tr-12").is_err(), "a number needs a board");
        assert!(trello_card_path("AbCd1234", "tr-x").is_err());
        assert!(trello_card_path("AbCd1234", "../members/me").is_err(), "no path traversal");
        assert!(trello_card_path("a/b", "tr-1").is_err());
    }

    #[test]
    fn trello_card_maps_list_member_and_label_and_falls_back_to_a_colour() {
        let card = serde_json::json!({
            "name": "Fix login", "idShort": 12, "shortUrl": "https://trello.com/c/Xy12Zq90",
            "list": { "name": "Doing" }, "members": [{ "fullName": "Joe" }],
            "labels": [{ "name": "", "color": "red" }]
        });
        let s = trello_summary(&card).unwrap();
        assert_eq!((s.id.as_str(), s.state.as_str(), s.ticket_type.as_str()), ("tr-12", "Doing", "red"));
        assert_eq!(s.owner.as_deref(), Some("Joe"));
        assert_eq!(s.url, "https://trello.com/c/Xy12Zq90");
        let bare = trello_summary(&serde_json::json!({ "name": "x", "idShort": 3, "labels": [], "members": [] })).unwrap();
        assert_eq!((bare.ticket_type.as_str(), bare.owner), ("card", None));
        assert!(trello_summary(&serde_json::json!({})).is_err());
    }

    #[test]
    fn trello_prompt_line_names_the_board_and_the_tr_form() {
        let t = TicketTracker { kind: TrackerKind::Trello, workspace: "AbCd1234".into() };
        let line = prompt_line(&t).unwrap();
        assert!(line.contains("board AbCd1234") && line.contains("tr-12"));
    }
}
