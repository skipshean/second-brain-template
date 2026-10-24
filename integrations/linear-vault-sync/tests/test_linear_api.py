import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from linear_api import LinearClient

def test_build_issue_query():
    client = LinearClient(api_key="test-key")
    query, variables = client._build_issues_query(
        team_id="abc-123",
        state_type="started",
        limit=50,
        cursor=None
    )
    assert "issues" in query
    assert variables["teamId"] == "abc-123"
    assert variables["first"] == 50

def test_build_update_issue_mutation():
    client = LinearClient(api_key="test-key")
    query, variables = client._build_update_issue_mutation(
        issue_id="uuid-here",
        updates={"stateId": "state-uuid", "dueDate": "2026-04-01"}
    )
    assert "issueUpdate" in query
    assert variables["id"] == "uuid-here"
    assert variables["input"]["dueDate"] == "2026-04-01"

def test_parse_issue_identifier():
    client = LinearClient(api_key="test-key")
    assert client.parse_identifier("TRA-125") == {"team_key": "TRA", "number": 125}
    assert client.parse_identifier("16W-1099") == {"team_key": "16W", "number": 1099}

if __name__ == "__main__":
    test_build_issue_query()
    test_build_update_issue_mutation()
    test_parse_issue_identifier()
    print("All linear_api tests passed!")
